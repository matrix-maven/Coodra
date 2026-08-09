import {Easing, interpolate, useCurrentFrame} from "remotion";
import {Eyebrow, Headline, Pill, SceneShell, Supporting, clamp} from "../components";
import {colors, text} from "../theme";

export const Guardrails: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <SceneShell label="Before writes">
      <div style={{position: "absolute", left: 80, right: 80, top: 212}}>
        <Eyebrow color={colors.warning}>Memory plus control</Eyebrow>
        <Headline size={78}>Policy checks risky actions before they happen.</Headline>
        <Supporting>Allow, ask, or deny rules are audit-logged locally.</Supporting>
      </div>
      <div
        style={{
          position: "absolute",
          left: 80,
          right: 80,
          bottom: 145,
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 14,
        }}
      >
        {[
          ["ALLOW", colors.success],
          ["ASK", colors.warning],
          ["DENY", "#EF4444"],
        ].map(([label, color], index) => (
          <div
            key={label}
            style={{
              opacity: interpolate(frame, [36 + index * 10, 54 + index * 10], [0, 1], {
                ...clamp,
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              }),
              backgroundColor: colors.surface,
              border: `1px solid ${color}`,
              color,
              fontFamily: text.mono,
              fontSize: 38,
              padding: "44px 18px",
              textAlign: "center",
            }}
          >
            {label}
          </div>
        ))}
      </div>
      <div style={{position: "absolute", right: 80, top: 542}}>
        <Pill tone="warn">check_policy</Pill>
      </div>
    </SceneShell>
  );
};

