/**
 * `TerminalView` — the TUI's `/01` tab. The splash hero on first boot;
 * a live command prompt that runs commands in-process and shows their
 * output. Every command typed is an observation on the context axis.
 *
 * It runs *any* `coodra` command in-process — including mutating
 * ones — except the handful that need their own terminal (interactive
 * readline prompts / browser sign-in) and `logs --follow` (streams
 * continuously). For those it surfaces a clear "run it in your own
 * terminal" note rather than hanging.
 */

import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useState } from 'react';
import { AxisNode, Banner, KeyValueRow, Prompt, SectionHead, Spinner, useTerminalSize } from '../../ui/ink/index.js';
import { palette } from '../../ui/theme.js';
import { isInteractiveCommand, isKnownCommand, parseCommandInput } from '../command-catalog.js';
import type { TuiContext } from '../context.js';
import { type CommandResult, runCommandInProcess } from '../run-command.js';

export interface TerminalViewProps {
  readonly ctx: TuiContext;
  readonly active: boolean;
  /** A command pushed from the Commands view to pre-fill the prompt. */
  readonly pendingCommand: string | null;
  readonly onPendingConsumed: () => void;
}

interface RanEntry {
  readonly command: string;
  readonly result: CommandResult;
}

export function TerminalView({ ctx, active, pendingCommand, onPendingConsumed }: TerminalViewProps) {
  const { exit } = useApp();
  const { rows } = useTerminalSize();
  const [input, setInput] = useState('');
  const [running, setRunning] = useState<string | null>(null);
  const [last, setLast] = useState<RanEntry | null>(null);
  const [history, setHistory] = useState<readonly string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Pull a command pushed from the Commands view into the prompt.
  useEffect(() => {
    if (pendingCommand !== null) {
      setInput(pendingCommand);
      setHistoryIndex(-1);
      onPendingConsumed();
    }
  }, [pendingCommand, onPendingConsumed]);

  // ↑/↓ command history. `ink-text-input` ignores the arrow keys we use
  // here, so this hook composes cleanly alongside the live input.
  useInput(
    (_char, key) => {
      if (running !== null) return;
      if (key.upArrow) {
        if (history.length === 0) return;
        const next = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(next);
        setInput(history[next] ?? '');
      } else if (key.downArrow) {
        if (historyIndex === -1) return;
        const next = historyIndex + 1;
        if (next >= history.length) {
          setHistoryIndex(-1);
          setInput('');
        } else {
          setHistoryIndex(next);
          setInput(history[next] ?? '');
        }
      }
    },
    { isActive: active },
  );

  const handleSubmit = async (value: string): Promise<void> => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    if (trimmed === 'exit' || trimmed === 'quit') {
      exit();
      return;
    }
    setHistory((h) => [...h, trimmed]);
    setHistoryIndex(-1);
    setInput('');

    const argv = parseCommandInput(trimmed);
    if (argv.length === 0) return;

    // A non-error informational note (the design system renders these neutrally).
    const note = (message: string): void => {
      setLast({ command: trimmed, result: { stdout: '', stderr: message, exitCode: 0, crashed: false } });
    };

    if (argv[0] === 'ui') {
      note("you're already in the interactive UI — type a command here, or press tab for the /02 catalog");
      return;
    }
    if (argv.includes('--follow')) {
      note('`logs --follow` streams continuously — run it in your own terminal');
      return;
    }
    if (isInteractiveCommand(argv)) {
      note(
        `\`coodra ${argv.join(' ')}\` needs its own terminal — it opens an interactive prompt or a browser sign-in. Run it in your shell.`,
      );
      return;
    }
    if (!isKnownCommand(argv)) {
      note(`'${argv[0]}' is not a coodra command — press tab for the /02 commands catalog`);
      return;
    }

    // Everything else runs in-process — including mutating commands.
    setRunning(trimmed);
    const result = await runCommandInProcess(argv);
    setRunning(null);
    setLast({ command: trimmed, result });
  };

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      {last === null ? (
        <SplashBody version={ctx.version} />
      ) : (
        <CommandResultBody entry={last} maxRows={Math.max(6, rows - 16)} />
      )}

      <Box marginTop={1}>
        {running !== null ? (
          <Box>
            <AxisNode verdict="ok" />
            <Text>{'  '}</Text>
            <Spinner label={`running ${running} …`} />
          </Box>
        ) : (
          <Prompt>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={(v) => {
                void handleSubmit(v);
              }}
              focus={active}
              placeholder="type a command — e.g. status, doctor, run list"
            />
          </Prompt>
        )}
      </Box>
    </Box>
  );
}

/** First-boot splash: the hero banner, a `try` row, and the controls legend. */
function SplashBody({ version }: { version: string }) {
  return (
    <Box flexDirection="column">
      <Banner version={version} />
      <Box marginTop={1}>
        <SectionHead num="01" title="try" />
      </Box>
      <Box>
        <Text color={palette.inkFar}>{'  › '}</Text>
        <Text color={palette.phosphor}>coodra status</Text>
        <Text color={palette.inkFar}>{'     › '}</Text>
        <Text color={palette.phosphor}>coodra doctor</Text>
        <Text color={palette.inkFar}>{'     › '}</Text>
        <Text color={palette.phosphor}>coodra run list</Text>
      </Box>
      <Box marginTop={1}>
        <SectionHead num="02" title="controls" />
      </Box>
      <KeyValueRow label="tab · shift+tab" value="switch views" valueTone="dim" labelWidth={20} />
      <KeyValueRow label="↑ · ↓" value="command history" valueTone="dim" labelWidth={20} />
      <KeyValueRow label="⏎" value="run command" valueTone="dim" labelWidth={20} />
      <KeyValueRow label="ctrl+c" value="quit" valueTone="dim" labelWidth={20} />
    </Box>
  );
}

/** The most-recent command: its prompt echo, then the captured output, capped to fit. */
function CommandResultBody({ entry, maxRows }: { entry: RanEntry; maxRows: number }) {
  const isErrorOnly = entry.result.stdout.length === 0;
  const raw = isErrorOnly ? entry.result.stderr : entry.result.stdout;
  const lines = raw.replace(/\n+$/, '').split('\n');
  const shown = lines.slice(0, maxRows);
  const hidden = lines.length - shown.length;
  const failed = entry.result.crashed || entry.result.exitCode > 1;
  // Only colour the output when it is a bare error string — captured
  // command stdout already carries the command's own design-system
  // colours and must render untouched.
  const errorTint = isErrorOnly && failed ? { color: palette.crimson } : {};

  return (
    <Box flexDirection="column">
      <Prompt command={entry.command} />
      <Box marginTop={1} flexDirection="column">
        {shown.map((line, index) => (
          // Output lines are positional and never reorder — index keys are correct here.
          // biome-ignore lint/suspicious/noArrayIndexKey: positional, stable output lines.
          <Text key={index} {...errorTint}>
            {line.length > 0 ? line : ' '}
          </Text>
        ))}
        {hidden > 0 ? (
          <Text
            color={palette.inkFar}
          >{`  … ${hidden} more line${hidden === 1 ? '' : 's'} — run \`${entry.command}\` in your shell for the full output`}</Text>
        ) : null}
      </Box>
    </Box>
  );
}
