import {Easing, interpolate, useCurrentFrame} from "remotion";
import {Eyebrow, Headline, Pill, SceneShell, Supporting, clamp} from "../components";
import {colors, text} from "../theme";

export const MemoryLoop: React.FC = () => {
  const frame = useCurrentFrame();
  const line = interpolate(frame, [48, 82], [0, 1], {
    ...clamp,
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  return (
    <SceneShell label="During the run">
      <div style={{position: "absolute", left: 80, right: 80, top: 210}}>
        <Eyebrow>Memory compounds</Eyebrow>
        <Headline size={78}>Decisions are recorded once, then reused.</Headline>
        <Supporting>Context packs capture the reasoning, files, tests, and open work.</Supporting>
      </div>
      <div
        style={{
          position: "absolute",
          left: 112,
          right: 112,
          bottom: 150,
          height: 210,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 102,
            height: 2,
            backgroundColor: colors.line,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 102,
            height: 2,
            width: `${line * 100}%`,
            backgroundColor: colors.green,
          }}
        />
        {["Session A", "Decision", "Next session"].map((label, index) => (
          <div
            key={label}
            style={{
              position: "absolute",
              left: `${index * 50}%`,
              translate: index === 2 ? "-100% 0" : index === 1 ? "-50% 0" : "0 0",
              top: 36,
              width: 220,
              textAlign: index === 2 ? "right" : index === 1 ? "center" : "left",
              opacity: interpolate(frame, [34 + index * 16, 52 + index * 16], [0, 1], clamp),
            }}
          >
            <div
              style={{
                width: 38,
                height: 38,
                marginLeft: index === 0 ? 0 : index === 1 ? 91 : 182,
                backgroundColor: index === 1 ? colors.green : colors.elevated,
                border: `2px solid ${index === 1 ? colors.green : colors.line}`,
              }}
            />
            <div
              style={{
                marginTop: 24,
                fontFamily: text.mono,
                color: index === 1 ? colors.green : colors.muted,
                fontSize: 23,
                textTransform: "uppercase",
              }}
            >
              {label}
            </div>
          </div>
        ))}
      </div>
      <div style={{position: "absolute", right: 80, top: 554}}>
        <Pill>search_packs_nl</Pill>
      </div>
    </SceneShell>
  );
};

