import {Audio, Easing, interpolate, staticFile, useCurrentFrame} from "remotion";
import {Eyebrow, Headline, SceneShell, clamp} from "../components";
import {colors, text} from "../theme";

const commands = [
  "npm i -g @coodra/cli",
  "coodra install",
  "coodra start",
  "coodra doctor",
  "coodra agent add codex",
  "coodra init",
];

export const Install: React.FC<{withAudio?: boolean}> = ({withAudio = false}) => {
  const frame = useCurrentFrame();

  return (
    <SceneShell label="Install">
      {withAudio ? <Audio src={staticFile("coodra-promo.wav")} /> : null}
      <div style={{position: "absolute", left: 80, right: 80, top: 190}}>
        <Eyebrow color={colors.blue}>Try it in your repo</Eyebrow>
        <Headline size={74}>One CLI. Local memory. Agent-native context.</Headline>
      </div>
      <div
        style={{
          position: "absolute",
          left: 80,
          right: 80,
          bottom: 130,
          backgroundColor: "#060609",
          border: `1px solid ${colors.line}`,
          padding: "30px",
        }}
      >
        {commands.map((command, index) => (
          <div
            key={command}
            style={{
              opacity: interpolate(frame, [32 + index * 8, 44 + index * 8], [0, 1], {
                ...clamp,
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              }),
              display: "flex",
              alignItems: "center",
              gap: 18,
              color: index === 0 ? colors.green : colors.text,
              fontFamily: text.mono,
              fontSize: 26,
              lineHeight: 1.55,
            }}
          >
            <span style={{color: colors.faint, width: 36}}>{String(index + 1).padStart(2, "0")}</span>
            <span>$ {command}</span>
          </div>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 80,
          bottom: 72,
          color: colors.muted,
          fontSize: 23,
        }}
      >
        Works with Codex, Claude Code, and Cursor.
      </div>
    </SceneShell>
  );
};
