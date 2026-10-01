/**
 * AskUserQuestion — Claude Code-style interactive questioning for Pi.
 *
 * Lets the model ask 1-4 multiple-choice questions with 2-4 options each,
 * directly during a turn. Mirrors Claude Code's AskUserQuestion tool:
 * - `header`: very short chip label (max 12 chars) shown in the tab bar
 * - `options`: distinct choices with label + description (+ optional preview)
 * - `multiSelect`: allow picking several options (Space/Enter toggles)
 * - An "Other" option is always appended automatically for free-text answers
 * - Put the recommended option first with "(Recommended)" in its label
 *
 * Modes:
 * - TUI: rich custom UI (tab bar, descriptions, preview, inline editor)
 * - RPC (`ctx.hasUI`): sequential select/input dialogs (RPC-safe)
 * - headless (print/json, no UI): returns an error telling the model
 *   to ask its questions in plain text instead.
 *
 * Every call also fires a `notify-send` desktop notification, so a question
 * raised while the pi window is buried behind something else still gets
 * noticed. See `desktopNotify`.
 *
 * Timeout: the whole call (all questions) must be answered within
 * `ASK_TIMEOUT_MS` (3 minutes). The TUI shows a live countdown; on expiry the
 * dialog closes itself and the tool returns TIMEOUT_MESSAGE, telling the
 * model not to re-ask. RPC dialogs get the remaining time via
 * `ExtensionUIDialogOptions.timeout`.
 *
 * Modes (tool param `mode`):
 * - `sync` (default): block the turn until answered / declined / timed out.
 * - `async`: return right away, leave the question open, and let the agent
 *   keep working. The reply is pushed back into the session with
 *   `pi.sendUserMessage()` when the user answers, declines (Esc), or the
 *   timeout fires — so the main agent is notified either way. Pending
 *   questions are tracked in `pendingQuestions` and can be inspected with
 *   `/ask-pending [id]`. Note that an open question still holds the keyboard
 *   while it is up (Esc dismisses it); the agent streams on behind it, and
 *   starting a new question withdraws any older pending one.
 *
 * Attribution
 * -----------
 * Independent implementation, written for this setup. Prior art, credited as
 * inspiration rather than as a source: Amos Blomqvist's pi-config ships an
 * `ask-user-question` extension for the same feature
 * (https://github.com/amosblomqvist/pi-config). A line-level comparison of
 * the two files found 59 shared non-blank lines out of 669 / 964, and zero
 * matching blocks of five or more consecutive lines -- shared idioms and
 * statements forced by pi's extension API (`return new Text(text, 0, 0)`,
 * `matchesKey(data, Key.enter)`), not a shared implementation. No code was
 * copied and none is inherited. This file is MIT licensed; pi-config carries
 * no license.
 */

import { spawn } from "node:child_process";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QuestionOption {
	label: string;
	description: string;
	preview?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
	question: string;
	header: string;
	options: QuestionOption[];
	multiSelect: boolean;
}

interface AskDetails {
	questions: { question: string; header: string; options: string[]; multiSelect: boolean }[];
	answers: Record<string, string>;
	cancelled: boolean;
	timedOut?: boolean;
	/** Async mode: the question is still open and will report back later. */
	pending?: boolean;
	questionId?: number;
}

/** Outcome of the TUI dialog: answers, user cancelled (null), or timed out. */
const TIMED_OUT = "timeout";
type TuiResult = { answers: Record<string, string> } | null | typeof TIMED_OUT;

/** How a question round should be driven. */
type AskMode = "sync" | "async";

/** Normalized result of a question round, shared by both modes and all UIs. */
type Outcome =
	| { kind: "answered"; answers: Record<string, string> }
	| { kind: "cancelled" }
	| { kind: "timeout" }
	| { kind: "error"; message: string };

/** An async question still waiting for the user (module-level, per process). */
interface PendingQuestion {
	id: number;
	questions: Question[];
	startedAt: number;
	deadline: number;
	/** Closes the dialog with no answer (slash command / supersede / shutdown). */
	cancel?: () => void;
	/** Set once the main agent has been told; later resolutions are ignored. */
	reported?: boolean;
}

const pendingQuestions = new Map<number, PendingQuestion>();
let nextQuestionId = 1;

// ---------------------------------------------------------------------------
// Schema (Claude Code compatible)
// ---------------------------------------------------------------------------

const OptionSchema = Type.Object({
	label: Type.String({
		description: "Display text (1-5 words), unique within the question.",
	}),
	description: Type.String({
		description: "What this option means; trade-offs or implications.",
	}),
	preview: Type.Optional(
		Type.String({
			description: "Optional code/mockup/config shown when the option is focused. Single-select only.",
		}),
	),
});

const QuestionSchema = Type.Object({
	question: Type.String({
		description: 'Complete question ending with "?". Unique across questions.',
	}),
	header: Type.String({
		description: 'Short tab label, max 12 chars. E.g. "Auth".',
	}),
	options: Type.Array(OptionSchema, {
		description: "2-4 distinct, mutually exclusive choices (unless multiSelect).",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Allow selecting several options. Default false.",
		}),
	),
});

const AskParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "1-4 questions to ask the user." }),
	mode: Type.Optional(
		Type.Union([Type.Literal("sync"), Type.Literal("async")], {
			default: "sync",
			description:
				"sync (default) blocks the turn until answered or declined. " +
				"async returns immediately and delivers the answer as a message later. " +
				"Use async only if you can make progress without the answer.",
		}),
	),
});

const MAX_HEADER = 12;

/** No reply at all for this long => give up and tell the model not to retry. */
const ASK_TIMEOUT_MINUTES = 3;
const ASK_TIMEOUT_MS = ASK_TIMEOUT_MINUTES * 60 * 1000;
const TIMEOUT_MESSAGE =
	`Timeout - user did not reply within ${ASK_TIMEOUT_MINUTES} minutes. Do not retry.`;

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: AskDetails } {
	return {
		content: [{ type: "text", text: message }],
		details: {
			questions: questions.map((q) => ({
				question: q.question,
				header: q.header,
				options: q.options.map((o) => o.label),
				multiSelect: q.multiSelect,
			})),
			answers: {},
			cancelled: true,
		},
	};
}

/** Validate raw params, return normalized questions (or an error string) + mode. */
function normalize(params: {
	questions: { question: string; header: string; options: QuestionOption[]; multiSelect?: boolean }[];
	mode?: string;
}): { questions?: Question[]; mode?: AskMode; error?: string } {
	const raw = params.questions;
	const mode: AskMode = params.mode === "async" ? "async" : "sync";
	if (!raw || raw.length === 0) return { error: "Error: provide 1-4 questions." };
	if (raw.length > 4) return { error: `Error: max 4 questions per call, got ${raw.length}. Split into multiple calls.` };

	const seenQ = new Set<string>();
	const questions: Question[] = [];
	for (let i = 0; i < raw.length; i++) {
		const q = raw[i];
		if (!q.question?.trim()) return { error: `Error: question ${i + 1} has empty text.` };
		if (seenQ.has(q.question)) return { error: `Error: question texts must be unique (duplicate: "${q.question}").` };
		seenQ.add(q.question);
		if (!q.options || q.options.length < 2) {
			return { error: `Error: question "${q.question}" needs 2-4 options, got ${q.options?.length ?? 0}.` };
		}
		if (q.options.length > 4) {
			return { error: `Error: question "${q.question}" has ${q.options.length} options, max is 4. Keep the most distinct ones.` };
		}
		const seenL = new Set<string>();
		for (const o of q.options) {
			if (!o.label?.trim()) return { error: `Error: question "${q.question}" has an option with empty label.` };
			if (seenL.has(o.label)) {
				return { error: `Error: option labels must be unique within a question (duplicate "${o.label}" in "${q.question}").` };
			}
			seenL.add(o.label);
		}
		questions.push({
			question: q.question,
			header: (q.header?.trim() || `Q${i + 1}`).slice(0, MAX_HEADER),
			options: q.options,
			multiSelect: q.multiSelect === true,
		});
	}
	return { questions, mode };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "AskUserQuestion",
		label: "AskUserQuestion",
		// Deferred: 433 tok of declarations on every request; tool_search
		// finds and activates it when the agent actually needs to ask.
		exposure: "deferred",
		description: [
			"Asks the user 1-4 multiple-choice questions (2-4 options each) to gather info, clarify ambiguity, or decide between options.",
			'An "Other" free-text option is appended automatically — never add your own.',
			'If you recommend an option, put it first with "(Recommended)" in its label.',
			'- mode "sync" (default) blocks the turn until answered; "async" returns at once and delivers the reply as a message later — keep working, never re-ask.',
			"- In plan mode, clarify requirements before finalizing, never ask for plan approval.",
			`- Times out after ${ASK_TIMEOUT_MINUTES} minutes with no reply; do not retry.`,
		].join("\n"),
		parameters: AskParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const norm = normalize(params as typeof params & { questions: Question[] });
			if (!norm.questions) return errorResult(norm.error!);
			const questions = norm.questions;
			const mode = norm.mode!;
			const isMulti = questions.length > 1;
			const deadline = Date.now() + ASK_TIMEOUT_MS;

			// Always ping the desktop: the TUI dialog is easy to miss when the
			// pi window is not focused (or is on another workspace).
			notifyQuestionAsked(questions, ctx.hasUI, mode);

			// -- Headless: no UI at all -> tell model to ask in text --
			if (!ctx.hasUI) {
				const listed = questions
					.map((q, i) => `${i + 1}. ${q.question} Options: ${q.options.map((o) => o.label).join(" / ")}`)
					.join("\n");
				return errorResult(
					`UI not available (non-interactive mode), could not ask questions. Ask the user directly in your reply text instead:\n${listed}`,
					questions,
				);
			}

			// -- RPC: custom() is unsupported there, so askViaDialogs() drives it --

			// Only one question dialog fits on screen: retire any async question
			// still waiting, otherwise it would be silently displaced.
			retirePendingQuestions(pi, SUPERSEDE_NOTE);

			// -- TUI: rich custom UI, shared by both modes --
			// `onReady` hands the async bookkeeping a way to close this dialog.
			const tuiFactory =
				(onReady?: (cancel: () => void) => void) =>
				(tui: TUI, theme: Theme, _kb: KeybindingsManager, done: (result: TuiResult) => void) => {
					const totalTabs = questions.length + (isMulti ? 1 : 0); // + Submit tab when multi
					let currentTab = 0;
					let optionIndex = 0;
					let inputMode = false;
					let cachedLines: string[] | undefined;
					// per-question state
					const singleSel = new Map<string, string>(); // question -> label
					const multiSel = new Map<string, Set<string>>(); // question -> labels
					const customAns = new Map<string, string>(); // question -> custom text
					for (const q of questions) if (q.multiSelect) multiSel.set(q.question, new Set());

					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					const editor = new Editor(tui, editorTheme);

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}
					function currentQ(): Question | undefined {
						return questions[currentTab];
					}
					function currentOpts(): RenderOption[] {
						const q = currentQ();
						if (!q) return [];
						return [...q.options, { label: "Other", description: "Write a custom answer.", isOther: true }];
					}
					function isAnswered(q: Question): boolean {
						if (q.multiSelect) {
							const s = multiSel.get(q.question)!;
							return s.size > 0 || (customAns.get(q.question)?.trim() ?? "") !== "";
						}
						return singleSel.has(q.question) || (customAns.get(q.question)?.trim() ?? "") !== "";
					}
					function allAnswered(): boolean {
						return questions.every(isAnswered);
					}
					function finalAnswer(q: Question): string {
						if (customAns.has(q.question) && !q.multiSelect) return customAns.get(q.question)!;
						if (q.multiSelect) {
							const parts = [...multiSel.get(q.question)!];
							const c = customAns.get(q.question)?.trim();
							if (c) parts.push(c);
							return parts.join(", ");
						}
						return singleSel.get(q.question) ?? "";
					}
					function collect(): Record<string, string> {
						const answers: Record<string, string> = {};
						for (const q of questions) answers[q.question] = finalAnswer(q);
						return answers;
					}

					// -- 3 minute timeout: close the dialog and report back to the model --
					let finished = false;
					let secondsLeft = Math.ceil(ASK_TIMEOUT_MS / 1000);
					const timer = setTimeout(() => finish(TIMED_OUT), ASK_TIMEOUT_MS);
					const ticker = setInterval(() => {
						const s = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
						if (s === secondsLeft) return;
						secondsLeft = s;
						refresh();
					}, 1000);
					// The countdown ticker must never keep the process alive; the
					// timeout timer deliberately does (the dialog is on screen, so
					// pi is alive anyway, and the notice must not be lost).
					ticker.unref?.();

					function finish(outcome: TuiResult) {
						if (finished) return;
						finished = true;
						clearInterval(ticker);
						clearTimeout(timer);
						done(outcome);
					}
					// Let the async bookkeeping close this dialog (e.g. /ask-pending <id>).
					onReady?.(() => finish(null));
					function advance() {
						if (!isMulti) {
							finish({ answers: collect() });
							return;
						}
						currentTab = currentTab < questions.length - 1 ? currentTab + 1 : questions.length; // Submit tab
						optionIndex = 0;
						refresh();
					}

					editor.onSubmit = (value) => {
						const q = currentQ();
						if (!q) return;
						const trimmed = value.trim();
						editor.setText("");
						if (trimmed) {
							customAns.set(q.question, trimmed);
							if (!q.multiSelect) singleSel.delete(q.question);
						}
						inputMode = false;
						if (!q.multiSelect) advance();
						else refresh();
					};

					function toggleMulti(q: Question, opt: RenderOption) {
						if (opt.isOther) {
							inputMode = true;
							editor.setText(customAns.get(q.question) ?? "");
							refresh();
							return;
						}
						const s = multiSel.get(q.question)!;
						if (s.has(opt.label)) s.delete(opt.label);
						else s.add(opt.label);
						refresh();
					}

					function handleInput(data: string) {
						if (inputMode) {
							if (matchesKey(data, Key.escape)) {
								inputMode = false;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}

						const q = currentQ();
						const opts = currentOpts();

						if (isMulti) {
							if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
								currentTab = (currentTab + 1) % totalTabs;
								optionIndex = 0;
								refresh();
								return;
							}
							if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
								currentTab = (currentTab - 1 + totalTabs) % totalTabs;
								optionIndex = 0;
								refresh();
								return;
							}
						}

						// Submit tab
						if (isMulti && currentTab === questions.length) {
							if (matchesKey(data, Key.enter) && allAnswered()) finish({ answers: collect() });
							else if (matchesKey(data, Key.escape)) finish(null);
							return;
						}
						if (!q) return;

						if (matchesKey(data, Key.up)) {
							optionIndex = Math.max(0, optionIndex - 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							optionIndex = Math.min(opts.length - 1, optionIndex + 1);
							refresh();
							return;
						}
						// number shortcuts 1..9
						const num = parseKeyNumber(data);
						if (num !== null && num >= 1 && num <= opts.length) {
							optionIndex = num - 1;
							const opt = opts[optionIndex];
							if (q.multiSelect) toggleMulti(q, opt);
							else if (opt.isOther) {
								inputMode = true;
								editor.setText("");
								refresh();
							} else {
								singleSel.set(q.question, opt.label);
								customAns.delete(q.question);
								advance();
							}
							return;
						}
						if (matchesKey(data, Key.space) && q.multiSelect) {
							toggleMulti(q, opts[optionIndex]);
							return;
						}
						if (matchesKey(data, Key.enter)) {
							const opt = opts[optionIndex];
							if (q.multiSelect) {
								toggleMulti(q, opt);
								return;
							}
							if (opt.isOther) {
								inputMode = true;
								editor.setText("");
								refresh();
								return;
							}
							singleSel.set(q.question, opt.label);
							customAns.delete(q.question);
							advance();
							return;
						}
						if (matchesKey(data, Key.escape)) {
							finish(null);
						}
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;
						const lines: string[] = [];
						const w = Math.max(1, width);
						const q = currentQ();
						const opts = currentOpts();

						function addWrapped(text: string) {
							lines.push(...wrapTextWithAnsi(text, w));
						}
						function addPrefixed(prefix: string, text: string) {
							const pw = visibleWidth(prefix);
							if (pw >= w) {
								addWrapped(prefix + text);
								return;
							}
							const wrapped = wrapTextWithAnsi(text, w - pw);
							const cont = " ".repeat(pw);
							for (let i = 0; i < wrapped.length; i++) lines.push(`${i === 0 ? prefix : cont}${wrapped[i]}`);
						}

						lines.push(theme.fg("accent", "─".repeat(w)));

						// Tab bar
						if (isMulti) {
							const tabs: string[] = ["← "];
							for (let i = 0; i < questions.length; i++) {
								const active = i === currentTab;
								const doneQ = isAnswered(questions[i]);
								const box = doneQ ? "■" : "□";
								const txt = ` ${box} ${questions[i].header} `;
								tabs.push(active ? theme.bg("selectedBg", theme.fg("text", txt)) : theme.fg(doneQ ? "success" : "muted", txt) + " ");
							}
							const canSubmit = allAnswered();
							const onSubmit = currentTab === questions.length;
							const st = " ✓ Submit ";
							tabs.push(onSubmit ? theme.bg("selectedBg", theme.fg("text", st)) : theme.fg(canSubmit ? "success" : "dim", st) + "→");
							addPrefixed(" ", tabs.join(""));
							lines.push("");
						}

						if (inputMode && q) {
							addPrefixed(" ", theme.fg("text", q.question));
							if (q.multiSelect) {
								const sel = multiSel.get(q.question)!;
								if (sel.size > 0) addPrefixed(" ", theme.fg("muted", `Selected: ${[...sel].join(", ")}`));
							}
							lines.push("");
							addPrefixed(" ", theme.fg("muted", "Your answer:"));
							for (const line of editor.render(Math.max(1, w - 2))) lines.push(` ${line}`);
							lines.push("");
							addPrefixed(" ", theme.fg("dim", "Enter to submit • Esc to go back"));
						} else if (isMulti && currentTab === questions.length) {
							addPrefixed(" ", theme.fg("accent", theme.bold("Ready to submit")));
							lines.push("");
							for (const qq of questions) {
								const a = isAnswered(qq) ? finalAnswer(qq) : theme.fg("warning", "(unanswered)");
								addPrefixed(" ", `${theme.fg("muted", `${qq.header}:`)} ${theme.fg("text", a)}`);
							}
							lines.push("");
							if (allAnswered()) addPrefixed(" ", theme.fg("success", "Press Enter to submit"));
							else {
								const missing = questions.filter((x) => !isAnswered(x)).map((x) => x.header).join(", ");
								addPrefixed(" ", theme.fg("warning", `Unanswered: ${missing} — go back with Tab/←→`));
							}
						} else if (q) {
							const tag = isMulti ? theme.fg("muted", `[${q.header}] `) : "";
							addPrefixed(" ", tag + theme.fg("text", q.question));
							if (q.multiSelect) {
								const sel = multiSel.get(q.question)!;
								if (sel.size > 0) addPrefixed(" ", theme.fg("muted", `Selected: ${[...sel].join(", ")}`));
							}
							lines.push("");
							for (let i = 0; i < opts.length; i++) {
								const opt = opts[i];
								const focused = i === optionIndex;
								const checked = q.multiSelect && !opt.isOther && multiSel.get(q.question)!.has(opt.label);
								const marker = q.multiSelect ? (checked ? "[x]" : "[ ]") : "";
								const prefix = focused ? theme.fg("accent", "> ") : "  ";
								const label = `${i + 1}. ${marker ? marker + " " : ""}${opt.label}${opt.isOther ? "." : ""}`;
								addPrefixed(prefix, theme.fg(focused ? "accent" : "text", label));
								if (opt.description) addPrefixed("      ", theme.fg("muted", opt.description));
								// preview of focused option
								if (focused && opt.preview) {
									addPrefixed("      ", theme.fg("dim", "╌ preview ╌"));
									for (const pl of opt.preview.split("\n")) addPrefixed("      ", theme.fg("dim", pl));
								}
							}
							// custom answer reminder for multiSelect
							const c = customAns.get(q.question)?.trim();
							if (q.multiSelect && c) addPrefixed(" ", theme.fg("muted", `Custom: ${c}`));
						}

						lines.push("");
						const help = q?.multiSelect
							? "↑↓ move • Space/Enter toggle • 1-4 quick pick • Tab switch Q • Esc cancel"
							: isMulti
								? "↑↓ move • Enter select • 1-4 quick pick • Tab switch Q • Esc cancel"
								: "↑↓ move • Enter select • 1-4 quick pick • Esc cancel";
						addPrefixed(" ", theme.fg("dim", help));
						addPrefixed(" ", countdownText(theme, secondsLeft));
						lines.push(theme.fg("accent", "─".repeat(w)));

						cachedLines = lines;
						return lines;
					}

					return {
						render,
						invalidate: () => (cachedLines = undefined),
						handleInput,
						dispose: () => {
							clearInterval(ticker);
							clearTimeout(timer);
						},
					};
				};

			/** Run one question round through whichever UI this mode supports. */
			const runRound = (onReady?: (cancel: () => void) => void): Promise<Outcome> => {
				if (ctx.mode !== "tui") return askViaDialogs(ctx, questions, deadline);
				return ctx.ui.custom<TuiResult>(tuiFactory(onReady)).then(
					(r): Outcome =>
						r === TIMED_OUT
							? { kind: "timeout" }
							: r === null
								? { kind: "cancelled" }
								: { kind: "answered", answers: r.answers },
					(e): Outcome => ({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
				);
			};

			// -- async: hand the question off and let this turn keep moving --
			if (mode === "async") {
				const id = nextQuestionId++;
				const record: PendingQuestion = { id, questions, startedAt: Date.now(), deadline };
				pendingQuestions.set(id, record);
				runRound((cancel) => (record.cancel = cancel)).then(
					(outcome) => settleAsyncQuestion(pi, record, outcome),
					(err) => settleAsyncQuestion(pi, record, { kind: "error", message: String(err) }),
				);
				const listed = questions.map((q) => `"${truncate(q.question, 70)}"`).join(" ");
				return {
					content: [
						{
							type: "text",
							text:
								`Async question #${id} is now open: ${listed}\n` +
								"This call returned immediately. Continue with everything that does not depend on the answer, " +
								"and do not ask the same question again — the reply arrives as a message when the user " +
								`answers, presses Esc, or ${ASK_TIMEOUT_MINUTES} minutes pass. /ask-pending shows it.`,
						},
					],
					details: { ...toDetails(questions, {}, false), pending: true, questionId: id },
				};
			}

			// -- sync: block this turn until answered / declined / timed out --
			return outcomeToResult(questions, await runRound());
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as { header?: string; question?: string }[]) ?? [];
			const chips = qs.map((q, i) => (q.header || `Q${i + 1}`).slice(0, MAX_HEADER)).join(", ");
			let text = theme.fg("toolTitle", theme.bold("AskUserQuestion "));
			text += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`);
			if ((args as { mode?: string }).mode === "async") text += theme.fg("accent", " (async)");
			if (chips) text += theme.fg("dim", ` (${chips})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskDetails | undefined;
			if (!details) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			if (details.pending) {
				return new Text(theme.fg("accent", `⏳ Question #${details.questionId} open (async) — reply comes as a message`), 0, 0);
			}
			if (details.timedOut) return new Text(theme.fg("error", `No answer after ${ASK_TIMEOUT_MINUTES} min`), 0, 0);
			if (details.cancelled) return new Text(theme.fg("warning", "Declined to answer"), 0, 0);
			const lines = Object.entries(details.answers).map(
				([qq, a]) => `${theme.fg("success", "✓ ")}${theme.fg("muted", truncate(qq, 60) + " → ")}${theme.fg("text", a)}`,
			);
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// -- Inspect / cancel async questions --
	pi.registerCommand("ask-pending", {
		description: "List open async questions, or cancel one: /ask-pending <id>",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg) {
				const id = Number.parseInt(arg, 10);
				const record = pendingQuestions.get(id);
				if (!record) {
					ctx.ui.notify(`No pending question #${arg}.`, "warning");
					return;
				}
				settleAsyncQuestion(pi, record, { kind: "cancelled" }, USER_CANCEL_NOTE);
				record.cancel?.();
				ctx.ui.notify(`Cancelled question #${id}.`, "info");
				return;
			}
			if (pendingQuestions.size === 0) {
				ctx.ui.notify("No pending questions.", "info");
				return;
			}
			const lines = [...pendingQuestions.values()].map((p) => {
				const left = Math.max(0, Math.ceil((p.deadline - Date.now()) / 1000));
				const age = Math.round((Date.now() - p.startedAt) / 1000);
				return `#${p.id} [${age}s old, ${left}s left] ${p.questions.map((q) => q.question).join(" | ")}`;
			});
			ctx.ui.notify(`Pending async questions: ${lines.join(" ;; ")}`, "info");
		},
	});

	// -- Never leave a dialog (or its timer) behind on shutdown/reload --
	pi.on("session_shutdown", async () => {
		for (const record of [...pendingQuestions.values()]) {
			record.reported = true; // no point waking the model during shutdown
			pendingQuestions.delete(record.id);
			record.cancel?.();
		}
	});
}

// ---------------------------------------------------------------------------
// Question rounds
// ---------------------------------------------------------------------------

/**
 * RPC/other-UI round: `custom()` is unsupported outside the TUI, so fall back
 * to sequential select/input dialogs. Every dialog gets the time left before
 * the shared deadline.
 */
async function askViaDialogs(ctx: ExtensionContext, questions: Question[], deadline: number): Promise<Outcome> {
	const timeLeft = () => Math.max(0, deadline - Date.now());
	const answers: Record<string, string> = {};
	for (const q of questions) {
		const labels = q.options.map((o) => o.label);
		if (!q.multiSelect) {
			const picked = await ctx.ui.select(q.question, [...labels, "Other (write custom answer)"], {
				timeout: timeLeft(),
			});
			if (picked === undefined) return dialogOutcome(answers, timeLeft());
			if (picked.startsWith("Other")) {
				const custom = await ctx.ui.input(`Custom answer: ${q.question}`, "Type something…", {
					timeout: timeLeft(),
				});
				if (custom === undefined) return dialogOutcome(answers, timeLeft());
				answers[q.question] = custom.trim() || "(no response)";
			} else {
				answers[q.question] = picked;
			}
		} else {
			const picked: string[] = [];
			let customText: string | undefined;
			for (;;) {
				const remaining = labels.filter((l) => !picked.includes(l));
				const choice = await ctx.ui.select(
					`${q.question} [${picked.length} selected: ${picked.join(", ") || "none"}]`,
					[...remaining, ...(customText ? [] : ["Other (write custom answer)"]), "Done"],
					{ timeout: timeLeft() },
				);
				if (choice === undefined) return dialogOutcome(answers, timeLeft());
				if (choice === "Done") {
					if (picked.length === 0 && !customText) {
						ctx.ui.notify("Select at least one option or cancel.", "warning");
						continue;
					}
					break;
				}
				if (choice.startsWith("Other")) {
					const custom = await ctx.ui.input(`Custom answer: ${q.question}`, "Type something…", {
						timeout: timeLeft(),
					});
					if (custom !== undefined && custom.trim()) customText = custom.trim();
					continue;
				}
				picked.push(choice);
				if (picked.length + (customText ? 1 : 0) >= labels.length + 1) break;
				if (remaining.length <= 1) break;
			}
			answers[q.question] = [...picked, ...(customText ? [customText] : [])].join(", ");
		}
	}
	return { kind: "answered", answers };
}

/** A dialog came back undefined: timeout if the budget is gone, else cancel. */
function dialogOutcome(answers: Record<string, string>, timeLeftMs: number): Outcome {
	return timeLeftMs <= 0 ? { kind: "timeout" } : { kind: "cancelled" };
}

/** Sync mode: turn an outcome into the tool result the model sees. */
function outcomeToResult(questions: Question[], outcome: Outcome) {
	switch (outcome.kind) {
		case "answered":
			return {
				content: [{ type: "text" as const, text: formatAnswers(questions, outcome.answers) }],
				details: toDetails(questions, outcome.answers, false),
			};
		case "timeout":
			desktopNotify("Question timed out", `No answer within ${ASK_TIMEOUT_MINUTES} minutes — moving on.`);
			return {
				content: [{ type: "text" as const, text: TIMEOUT_MESSAGE }],
				details: toDetails(questions, {}, true, true),
			};
		case "cancelled":
			return {
				content: [{ type: "text" as const, text: "User declined to answer questions." }],
				details: toDetails(questions, {}, true),
			};
		default:
			return {
				content: [{ type: "text" as const, text: `Question failed: ${outcome.message}` }],
				details: toDetails(questions, {}, true),
			};
	}
}

const SUPERSEDE_NOTE =
	"Another question replaced it before the user answered. Ignore it unless the topic comes up again; do not re-ask.";
const USER_CANCEL_NOTE = "The user cancelled this pending question from the pi window. Do not re-ask.";

/**
 * Withdraw every still-open async question (only one dialog fits on screen) and
 * tell the agent why, so it does not sit around waiting for an answer that will
 * never come.
 */
function retirePendingQuestions(pi: ExtensionAPI, note: string): void {
	for (const record of [...pendingQuestions.values()]) {
		settleAsyncQuestion(pi, record, { kind: "cancelled" }, note);
		record.cancel?.();
	}
}

/**
 * Async mode: the tool call already returned, so push the result back into the
 * session as a user message. Always fires — answered, declined, timed out or
 * errored — so the main agent learns the outcome either way. `note` overrides
 * the declined wording (superseded / user-cancelled).
 */
function settleAsyncQuestion(pi: ExtensionAPI, record: PendingQuestion, outcome: Outcome, note?: string): void {
	pendingQuestions.delete(record.id);
	if (record.reported) return; // already reported; this is a late duplicate
	record.reported = true;
	const tag = `[AskUserQuestion #${record.id}`;
	let body: string;
	switch (outcome.kind) {
		case "answered":
			body = `${tag} answered]\n${formatAnswers(record.questions, outcome.answers)}`;
			desktopNotify("Question answered", `Async question #${record.id} is answered.`);
			break;
		case "timeout":
			body = `${tag} timed out]\n${TIMEOUT_MESSAGE}`;
			desktopNotify("Question timed out", `Async question #${record.id} got no reply in ${ASK_TIMEOUT_MINUTES} min.`);
			break;
		case "cancelled":
			body = `${tag} ${note ? "cancelled" : "declined"}]\n${
				note ?? "The user dismissed the question without answering. Do not re-ask the same thing; proceed with your best guess or ask something different."
			}`;
			desktopNotify("Question dismissed", `Async question #${record.id} was dismissed.`);
			break;
		default:
			body = `${tag} failed]\nThe question UI errored: ${outcome.message}`;
			desktopNotify("Question failed", `Async question #${record.id} errored.`);
	}
	try {
		// followUp: never interrupts the running turn, always starts one when idle.
		pi.sendUserMessage(body, { deliverAs: "followUp" });
	} catch {
		// Session replaced/reloaded underneath us: the pending entry is gone, nothing to do.
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Desktop notification
// ---------------------------------------------------------------------------

/** Fires for every question set, prompting or not. */
function notifyQuestionAsked(questions: Question[], willPrompt: boolean, mode: AskMode = "sync") {
	const first = questions[0].question.replace(/\s+/g, " ").trim();
	const extra = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";
	const how = !willPrompt
		? "answer in the pi agent output"
		: mode === "async"
			? "answer now or whenever — the agent keeps working"
			: "look into the pi agent window to answer";
	desktopNotify("Agent asked a question", `${truncate(first, 120)}${extra} — ${how}.`);
}

/**
 * Fire-and-forget `notify-send`. Detached and unref'd so it never blocks or
 * keeps the process alive, and every failure path is swallowed: no desktop, no
 * notification daemon, or no `notify-send` binary must not fail the tool call.
 */
function desktopNotify(title: string, body: string): void {
	try {
		const child = spawn("notify-send", ["--app-name=pi", "--icon=dialog-question", title, body], {
			detached: true,
			stdio: "ignore",
		});
		child.on("error", () => {});
		child.unref();
	} catch {
		// Best effort only.
	}
}

function toDetails(
	questions: Question[],
	answers: Record<string, string>,
	cancelled: boolean,
	timedOut = false,
	pending = false,
	questionId?: number,
): AskDetails {
	return {
		questions: questions.map((q) => ({
			question: q.question,
			header: q.header,
			options: q.options.map((o) => o.label),
			multiSelect: q.multiSelect,
		})),
		answers,
		cancelled,
		timedOut,
		pending,
		questionId,
	};
}

/** "⏱ 2:59 left to answer" — turns red under a minute. */
function countdownText(theme: Theme, secondsLeft: number): string {
	const m = Math.floor(secondsLeft / 60);
	const s = secondsLeft % 60;
	const label = `⏱ ${m}:${String(s).padStart(2, "0")} left to answer`;
	return secondsLeft <= 60 ? theme.fg("error", label) : theme.fg("dim", label);
}

function formatAnswers(questions: Question[], answers: Record<string, string>): string {
	return questions.map((q) => `"${q.question}"="${answers[q.question] ?? "(no answer)"}"`).join(", ");
}

function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Parse a bare digit keypress ("1".."9"); null otherwise. */
function parseKeyNumber(data: string): number | null {
	// TUI keys arrive as raw sequences; a lone ASCII digit is a single char.
	if (/^[1-9]$/.test(data)) return Number(data);
	return null;
}
