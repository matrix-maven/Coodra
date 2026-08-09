import {Easing, interpolate, useCurrentFrame} from "remotion";
import {Eyebrow, Headline, Pill, SceneShell, clamp} from "../components";
import {colors, text} from "../theme";

const items = [
  {title: "Recipes", body: "task guidance"},
  {title: "Recent decisions", body: "what changed"},
  {title: "Context packs", body: "why it matters"},
];

export const ContextLayer: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <SceneShell label="Session start">
      <div style={{position: "absolute", left: 80, right: 80, top: 218}}>
        <Eyebrow color={colors.blue}>Injected before the first prompt</Eyebrow>
        <Headline size={76}>The agent opens with the right project context.</Headline>
      </div>
      <div
        style={{
          position: "absolute",
          left: 80,
          right: 80,
          bottom: 140,
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: 16,
        }}
      >
        {items.map((item, index) => (
          <div
            key={item.title}
            style={{
              opacity: interpolate(frame, [30 + index * 10, 48 + index * 10], [0, 1], {
                ...clamp,
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              }),
              translate: `${interpolate(frame, [30 + index * 10, 48 + index * 10], [-34, 0], clamp)}px 0`,
              border: `1px solid ${colors.line}`,
              backgroundColor: colors.surface,
              padding: "28px 30px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{fontSize: 40, lineHeight: 1.1, fontWeight: 700}}>{item.title}</div>
            <div style={{fontFamily: text.mono, color: colors.muted, fontSize: 24}}>
              {item.body}
            </div>
          </div>
        ))}
      </div>
      <div style={{position: "absolute", right: 80, top: 478}}>
        <Pill tone="green">local-first</Pill>
      </div>
    </SceneShell>
  );
};

