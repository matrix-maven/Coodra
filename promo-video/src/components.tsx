import type {ReactNode} from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {colors, text} from "./theme";

export const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

export const enter = (frame: number, start = 0, end = 18) =>
  interpolate(frame, [start, end], [0, 1], {
    ...clamp,
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

export const SceneShell: React.FC<{
  children: ReactNode;
  label: string;
  dark?: boolean;
}> = ({children, label, dark = true}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const progress = interpolate(frame, [0, durationInFrames], [0, 1], clamp);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: dark ? colors.bg : "#F4F4F8",
        color: dark ? colors.text : "#262626",
        fontFamily: text.family,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "linear-gradient(rgba(240,240,245,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(240,240,245,0.05) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          opacity: dark ? 1 : 0.42,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 80,
          right: 80,
          top: 62,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          opacity: enter(frame, 0, 18),
        }}
      >
        <Img
          src={staticFile("coodra-lockup.svg")}
          style={{
            width: 270,
            filter: dark ? "none" : "invert(1)",
          }}
        />
        <div
          style={{
            border: `1px solid ${dark ? colors.line : "rgba(38,38,38,0.18)"}`,
            color: dark ? colors.muted : "#757575",
            fontFamily: text.mono,
            fontSize: 20,
            padding: "10px 14px",
            textTransform: "uppercase",
          }}
        >
          {label}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 80,
          right: 80,
          bottom: 56,
          height: 3,
          backgroundColor: dark ? "rgba(240,240,245,0.12)" : "rgba(38,38,38,0.12)",
        }}
      >
        <div
          style={{
            width: `${progress * 100}%`,
            height: "100%",
            backgroundColor: colors.blue,
          }}
        />
      </div>
      {children}
    </AbsoluteFill>
  );
};

export const Eyebrow: React.FC<{children: ReactNode; color?: string}> = ({
  children,
  color = colors.green,
}) => {
  const frame = useCurrentFrame();

  return (
    <div
      style={{
        opacity: enter(frame, 4, 20),
        translate: `0 ${interpolate(frame, [4, 20], [18, 0], clamp)}px`,
        color,
        fontFamily: text.mono,
        fontSize: 24,
        letterSpacing: 0,
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
};

export const Headline: React.FC<{children: ReactNode; size?: number}> = ({
  children,
  size = 84,
}) => {
  const frame = useCurrentFrame();

  return (
    <div
      style={{
        opacity: enter(frame, 10, 28),
        translate: `0 ${interpolate(frame, [10, 28], [28, 0], clamp)}px`,
        fontSize: size,
        fontWeight: 300,
        lineHeight: 1.08,
        letterSpacing: 0,
        textTransform: "uppercase",
        maxWidth: 900,
      }}
    >
      {children}
    </div>
  );
};

export const Supporting: React.FC<{children: ReactNode; top?: number}> = ({
  children,
  top = 28,
}) => {
  const frame = useCurrentFrame();

  return (
    <div
      style={{
        marginTop: top,
        opacity: enter(frame, 22, 42),
        translate: `0 ${interpolate(frame, [22, 42], [20, 0], clamp)}px`,
        color: colors.muted,
        fontSize: 38,
        lineHeight: 1.22,
        maxWidth: 850,
      }}
    >
      {children}
    </div>
  );
};

export const Pill: React.FC<{children: ReactNode; tone?: "green" | "blue" | "warn"}> = ({
  children,
  tone = "blue",
}) => {
  const map = {
    blue: colors.blue,
    green: colors.success,
    warn: colors.warning,
  };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        border: `1px solid ${map[tone]}`,
        color: map[tone],
        fontFamily: text.mono,
        fontSize: 22,
        padding: "8px 12px",
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  );
};

