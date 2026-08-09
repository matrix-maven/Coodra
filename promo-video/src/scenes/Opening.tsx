import {Easing, interpolate, useCurrentFrame} from "remotion";
import {Eyebrow, Headline, SceneShell, Supporting, clamp} from "../components";
import {colors, text} from "../theme";

export const Opening: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <SceneShell label="Memory for agents">
      <div style={{position: "absolute", left: 80, right: 80, top: 250}}>
        <Eyebrow>Stop re-teaching your repo</Eyebrow>
        <Headline>AI agents forget between sessions.</Headline>
        <Supporting>
          Coodra gives Codex, Claude, and Cursor a local memory and context layer.
        </Supporting>
      </div>
      <div
        style={{
          position: "absolute",
          left: 80,
          right: 80,
          bottom: 150,
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 14,
          opacity: interpolate(frame, [35, 58], [0, 1], {
            ...clamp,
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        {["Decisions", "Context Packs", "Policy"].map((item) => (
          <div
            key={item}
            style={{
              border: `1px solid ${colors.line}`,
              backgroundColor: colors.surface,
              color: item === "Context Packs" ? colors.green : colors.text,
              fontFamily: text.mono,
              fontSize: 24,
              padding: "24px 22px",
              textTransform: "uppercase",
            }}
          >
            {item}
          </div>
        ))}
      </div>
    </SceneShell>
  );
};

