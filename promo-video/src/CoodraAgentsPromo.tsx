import {Easing, Img, interpolate, Sequence, staticFile, useCurrentFrame} from "remotion";

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1920;
const DURATION_SECONDS = 30;
const clamp = {extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const};
const ease = Easing.bezier(0.16, 1, 0.3, 1);

const serif = "Georgia, 'Times New Roman', serif";
const mono = "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace";

const fade = (frame: number, start: number, end: number) =>
  interpolate(frame, [start, end], [0, 1], {...clamp, easing: ease});

const Grid: React.FC = () => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      backgroundColor: "#020905",
      backgroundImage:
        "linear-gradient(rgba(125,216,125,0.055) 1px, transparent 1px), linear-gradient(90deg, rgba(125,216,125,0.055) 1px, transparent 1px)",
      backgroundSize: "80px 80px",
    }}
  />
);

const TopRule: React.FC = () => (
  <div style={{position: "absolute", left: 0, right: 0, top: 0, height: 2, background: "#7dd87d", opacity: 0.9}} />
);

const Progress: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <div style={{position: "absolute", left: 0, right: 0, bottom: 0, height: 2, background: "#102018"}}>
      <div
        style={{
          height: "100%",
          width: `${interpolate(frame, [0, DURATION_SECONDS * FPS], [0, 100], clamp)}%`,
          background: "#7dd87d",
        }}
      />
    </div>
  );
};

const Underline: React.FC<{children: React.ReactNode; color?: string}> = ({children, color = "#7dd87d"}) => (
  <span
    style={{
      textDecoration: "underline",
      textDecorationColor: color,
      textDecorationThickness: 3,
      textUnderlineOffset: 10,
    }}
  >
    {children}
  </span>
);

const Eyebrow: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div style={{fontFamily: mono, fontSize: 34, letterSpacing: 12, textTransform: "uppercase", color: "#7dd87d", lineHeight: 1.25}}>
    {children}
  </div>
);

const Shell: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div style={{position: "absolute", inset: 0, overflow: "hidden"}}>
    <Grid />
    <TopRule />
    <Progress />
    {children}
  </div>
);

const ClaudeCodeIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
    <path
      d="M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z"
      fill="currentColor"
    />
  </svg>
);

const CursorIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
    <path
      d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"
      fill="currentColor"
    />
  </svg>
);

const CodexIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
    <rect width="24" height="24" rx="4.5" fill="#f6f5f0" />
    <path
      d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"
      fill="#3941ff"
    />
  </svg>
);

const DevinIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
    <path
      d="M2.033 9.867l2.554 1.483a.589.589 0 00.592 0l2.554-1.483a.596.596 0 00.297-.516V7.868c0-.572.307-1.105.8-1.392a1.595 1.595 0 011.598 0l1.277.742a.587.587 0 00.591 0l2.554-1.483a.596.596 0 00.297-.516V2.253a.595.595 0 00-.297-.516L12.293.257a.587.587 0 00-.591 0L9.148 1.737a.596.596 0 00-.296.516v1.483c0 .572-.307 1.105-.8 1.393a1.597 1.597 0 01-1.599 0l-1.276-.742a.587.587 0 00-.592 0L2.033 5.872a.596.596 0 00-.297.515v2.966c0 .213.113.41.297.515z"
      fill="#3969ca"
    />
    <path
      d="M15.943 10.607a1.596 1.596 0 011.599 0l1.276.74a.587.587 0 00.592 0l2.554-1.482a.597.597 0 00.297-.516V6.383a.596.596 0 00-.297-.515l-2.552-1.483a.587.587 0 00-.592 0l-2.553 1.482a.596.596 0 00-.296.516v1.482c0 .572-.307 1.105-.8 1.393a1.597 1.597 0 01-1.599 0l-1.276-.742a.587.587 0 00-.592 0L9.15 10a.596.596 0 00-.296.516v2.966c0 .212.112.409.296.515l2.554 1.483a.587.587 0 00.592 0l1.277-.741a1.597 1.597 0 012.398 1.392v1.482c0 .213.112.41.296.516l2.554 1.483a.59.59 0 00.593 0l2.554-1.483a.597.597 0 00.296-.516v-2.965a.595.595 0 00-.296-.516l-2.554-1.483a.587.587 0 00-.592 0l-1.276.742a1.595 1.595 0 01-1.598 0 1.615 1.615 0 010-2.785z"
      fill="#21c19a"
    />
    <path
      d="M14.848 18.265l-2.554-1.482a.587.587 0 00-.592 0l-1.276.742a1.594 1.594 0 01-1.598 0c-.493-.286-.8-.82-.8-1.393V14.65a.596.596 0 00-.296-.516L5.178 12.65a.587.587 0 00-.591 0l-2.554 1.483a.596.596 0 00-.297.516v2.965c0 .213.113.41.297.516l2.554 1.483a.587.587 0 00.591 0l1.277-.742a1.597 1.597 0 012.398 1.393v1.482c0 .213.112.41.296.516l2.554 1.483a.587.587 0 00.593 0l2.554-1.483a.596.596 0 00.296-.515v-2.966a.596.596 0 00-.296-.516z"
      fill="#0294de"
    />
  </svg>
);

const agents = [
  {name: "Claude Code", token: "claude", accent: "#d97757", icon: <ClaudeCodeIcon />},
  {name: "Codex", token: "codex", accent: "#7a9dff", icon: <CodexIcon />},
  {name: "Cursor", token: "cursor", accent: "#f4f1e8", icon: <CursorIcon />},
  {name: "Devin", token: "devin", accent: "#21c19a", icon: <DevinIcon />},
  {name: "Antigravity", token: "antigravity", accent: "#3186ff", image: "agents/antigravity.png"},
] as const;

const AgentTile: React.FC<{agent: (typeof agents)[number]; index: number; compact?: boolean}> = ({agent, index, compact = false}) => {
  const frame = useCurrentFrame();
  const enter = fade(frame, 8 + index * 5, 28 + index * 5);
  const size = compact ? 150 : 218;
  return (
    <div
      style={{
        width: compact ? 212 : 340,
        height: compact ? 210 : 328,
        border: "1px solid rgba(125,216,125,0.18)",
        background: "rgba(5,17,10,0.88)",
        display: "grid",
        gridTemplateRows: `${size}px 1fr`,
        opacity: enter,
        translate: `0 ${interpolate(frame, [8 + index * 5, 28 + index * 5], [20, 0], clamp)}px`,
      }}
    >
      <div style={{display: "grid", placeItems: "center", color: agent.accent}}>
        <div
          style={{
            width: compact ? 76 : 126,
            height: compact ? 76 : 126,
            display: "grid",
            placeItems: "center",
            color: agent.accent,
          }}
        >
          {"image" in agent ? (
            <Img src={staticFile(agent.image)} style={{width: "100%", height: "100%", objectFit: "contain"}} />
          ) : (
            agent.icon
          )}
        </div>
      </div>
      <div style={{borderTop: "1px solid rgba(125,216,125,0.12)", padding: compact ? "16px 18px" : "18px 22px"}}>
        <div style={{fontFamily: serif, fontSize: compact ? 24 : 40, color: "#f4f1e8", lineHeight: 1}}>{agent.name}</div>
        <div style={{marginTop: 16, fontFamily: mono, fontSize: compact ? 10 : 14, color: "#7dd87d", letterSpacing: 3, textTransform: "uppercase"}}>
          coodra agent add
          <br />
          {agent.token}
        </div>
      </div>
    </div>
  );
};

const HookScene: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Shell>
      <div style={{position: "absolute", left: 120, right: 120, top: 600, textAlign: "center"}}>
        <div
          style={{
            fontFamily: mono,
            fontSize: 30,
            letterSpacing: 12,
            textTransform: "uppercase",
            color: "#7dd87d",
            opacity: fade(frame, 8, 28),
          }}
        >
          Coodra for coding agents
        </div>
        <div
          style={{
            marginTop: 38,
            fontFamily: serif,
            fontSize: 148,
            lineHeight: 1.02,
            color: "#f4f1e8",
            opacity: fade(frame, 18, 46),
            translate: `0 ${interpolate(frame, [18, 46], [24, 0], clamp)}px`,
          }}
        >
          <Underline>Supercharge</Underline>
          <br />
          your coding agent.
        </div>
      </div>
    </Shell>
  );
};

const ConstellationScene: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Shell>
      <div style={{position: "absolute", left: 120, top: 118, fontFamily: mono, fontSize: 18, letterSpacing: 6, color: "rgba(232,230,225,0.38)"}}>
        01 / 03
      </div>
      <div style={{position: "absolute", left: 120, right: 120, top: 244, textAlign: "center"}}>
        <div style={{opacity: fade(frame, 8, 24)}}>
          <Eyebrow>One memory layer</Eyebrow>
        </div>
        <div style={{marginTop: 42, fontFamily: serif, fontSize: 122, lineHeight: 1.02, color: "#f4f1e8", opacity: fade(frame, 15, 36)}}>
          Five agents.
          <br />
          <Underline>Same context.</Underline>
        </div>
        <div style={{marginTop: 34, fontFamily: mono, fontSize: 26, lineHeight: 1.7, color: "rgba(232,230,225,0.58)", opacity: fade(frame, 34, 58)}}>
          Claude Code / Codex / Cursor / Devin / Antigravity
        </div>
      </div>
      <div style={{position: "absolute", left: 420, top: 840, display: "grid", gridTemplateColumns: "repeat(3, 340px)", gap: 30}}>
        {agents.slice(0, 3).map((agent, index) => (
          <AgentTile key={agent.name} agent={agent} index={index} />
        ))}
      </div>
      <div style={{position: "absolute", left: 595, top: 1210, display: "grid", gridTemplateColumns: "repeat(2, 340px)", gap: 30}}>
        {agents.slice(3).map((agent, index) => (
          <AgentTile key={agent.name} agent={agent} index={index + 3} />
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 660,
          top: 1620,
          width: 600,
          height: 96,
          display: "grid",
          placeItems: "center",
          border: "1px solid rgba(125,216,125,0.28)",
          color: "#f4f1e8",
          fontFamily: mono,
          fontSize: 24,
          letterSpacing: 8,
          textTransform: "uppercase",
          opacity: fade(frame, 58, 78),
        }}
      >
        Powered by Coodra
      </div>
    </Shell>
  );
};

const LayerScene: React.FC = () => {
  const frame = useCurrentFrame();
  const items = [
    ["Agent Recipes", "load know-how only when it matches"],
    ["Context Packs", "carry session summaries forward"],
    ["Decisions", "preserve why the code changed"],
    ["Work Packs", "keep issue and PR work connected"],
    ["Code Graph", "map the codebase relationships"],
    ["Code Wiki", "turn code knowledge into living docs"],
  ];
  return (
    <Shell>
      <div style={{position: "absolute", left: 120, top: 118, fontFamily: mono, fontSize: 18, letterSpacing: 6, color: "rgba(232,230,225,0.38)"}}>
        02 / 03
      </div>
      <div style={{position: "absolute", left: 120, right: 120, top: 250, textAlign: "center"}}>
        <div style={{opacity: fade(frame, 8, 24)}}>
          <Eyebrow>What Coodra adds</Eyebrow>
        </div>
        <div style={{marginTop: 42, fontFamily: serif, fontSize: 118, lineHeight: 1.02, color: "#f4f1e8", opacity: fade(frame, 18, 38)}}>
          Memory. <Underline>Context.</Underline>
          <br />Guardrails.
        </div>
      </div>
      <div style={{position: "absolute", left: 170, right: 170, top: 760, borderTop: "1px solid rgba(125,216,125,0.22)"}}>
        {items.map(([title, body], index) => (
          <div
            key={title}
            style={{
              height: 150,
              display: "grid",
              gridTemplateColumns: "440px 1fr",
              alignItems: "center",
              borderBottom: "1px solid rgba(125,216,125,0.14)",
              opacity: fade(frame, 18 + index * 8, 38 + index * 8),
            }}
          >
            <div style={{fontFamily: serif, fontSize: 58, color: index === 2 ? "#7dd87d" : "#f4f1e8"}}>
              {title === "Agent Recipes" || title === "Decisions" || title === "Work Packs" ? <Underline>{title}</Underline> : title}
            </div>
            <div style={{fontFamily: mono, fontSize: 28, lineHeight: 1.5, color: "rgba(232,230,225,0.62)"}}>{body}</div>
          </div>
        ))}
      </div>
    </Shell>
  );
};

const InstallScene: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Shell>
      <div style={{position: "absolute", left: 120, top: 118, fontFamily: mono, fontSize: 18, letterSpacing: 6, color: "rgba(232,230,225,0.38)"}}>
        03 / 03
      </div>
      <div style={{position: "absolute", left: 120, right: 120, top: 500, textAlign: "center", opacity: fade(frame, 8, 28)}}>
        <div style={{fontFamily: serif, fontSize: 132, lineHeight: 1.08, color: "#f4f1e8"}}>
          Give every agent
          <br />
          the <Underline>same memory</Underline>.
        </div>
        <div style={{margin: "78px auto 0", width: 1220, border: "1px solid rgba(125,216,125,0.28)", background: "rgba(125,216,125,0.055)", padding: "54px 60px", textAlign: "center"}}>
          <div style={{fontFamily: mono, fontSize: 48, color: "#f4f1e8"}}>
            <span style={{color: "#7dd87d"}}>$</span> npm i -g @coodra/cli
          </div>
          <div style={{marginTop: 34, fontFamily: mono, fontSize: 48, color: "#f4f1e8"}}>
            <span style={{color: "#7dd87d"}}>$</span> coodra agent add &lt;agent&gt;
          </div>
        </div>
      </div>
      <div style={{position: "absolute", left: 0, right: 0, bottom: 230, display: "flex", justifyContent: "center", gap: 18, opacity: fade(frame, 44, 64)}}>
        {agents.map((agent, index) => (
          <div
            key={agent.name}
            style={{
              height: 72,
              padding: "0 28px",
              display: "flex",
              alignItems: "center",
              border: "1px solid rgba(125,216,125,0.2)",
              color: index === 4 ? "#7dd87d" : "rgba(232,230,225,0.72)",
              fontFamily: mono,
              fontSize: 20,
              letterSpacing: 5,
              textTransform: "uppercase",
            }}
          >
            {agent.token}
          </div>
        ))}
      </div>
    </Shell>
  );
};

export const CoodraAgentsPromo: React.FC = () => (
  <>
    <Sequence durationInFrames={5 * FPS} name="Hook">
      <HookScene />
    </Sequence>
    <Sequence from={5 * FPS} durationInFrames={9 * FPS} name="Agent constellation">
      <ConstellationScene />
    </Sequence>
    <Sequence from={14 * FPS} durationInFrames={8 * FPS} name="Layer">
      <LayerScene />
    </Sequence>
    <Sequence from={22 * FPS} durationInFrames={8 * FPS} name="Install">
      <InstallScene />
    </Sequence>
  </>
);

export const coodraAgentsPromoConfig = {
  id: "CoodraAgentsPromo",
  durationInFrames: DURATION_SECONDS * FPS,
  fps: FPS,
  width: WIDTH,
  height: HEIGHT,
};
