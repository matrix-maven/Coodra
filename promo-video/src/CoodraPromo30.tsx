import {Audio, Easing, interpolate, Sequence, staticFile, useCurrentFrame} from "remotion";

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const clamp = {extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const};

const chapters = [
  {
    chapter: "01",
    label: "Memory",
    title: ["Every run,", "remembered."],
    note: "the next session resumes, not restarts",
    mock: "session",
    underline: "remembered.",
  },
  {
    chapter: "02",
    label: "Agent Recipes",
    title: ["Know-how,", "on demand."],
    note: "pulled only when the prompt matches",
    mock: "recipes",
    underline: "on demand.",
  },
  {
    chapter: "03",
    label: "Context Packs",
    title: ["Every session,", "recapped."],
    note: "what changed, why it changed, what remains",
    mock: "packs",
    underline: "recapped.",
  },
  {
    chapter: "04",
    label: "Work Packs",
    title: ["Issue work,", "carried forward."],
    note: "issue-bound context across sessions",
    mock: "work",
    underline: "carried forward.",
  },
  {
    chapter: "05",
    label: "Deep Wiki",
    title: ["Docs your", "agent writes."],
    note: "grounded in Graphify, saved in Coodra",
    mock: "wiki",
    underline: "agent writes.",
  },
] as const;

const serif = "Georgia, 'Times New Roman', serif";
const mono = "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace";
const sans = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

const ease = Easing.bezier(0.16, 1, 0.3, 1);

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

const Progress: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <div style={{position: "absolute", left: 0, right: 0, bottom: 0, height: 2, background: "#102018"}}>
      <div
        style={{
          height: "100%",
          width: `${interpolate(frame, [0, 30 * FPS], [0, 100], clamp)}%`,
          background: "#7dd87d",
        }}
      />
    </div>
  );
};

const TopRule: React.FC = () => (
  <div style={{position: "absolute", left: 0, right: 0, top: 0, height: 2, background: "#7dd87d", opacity: 0.9}} />
);

const Underline: React.FC<{children: React.ReactNode}> = ({children}) => (
  <span
    style={{
      textDecoration: "underline",
      textDecorationColor: "#7dd87d",
      textDecorationThickness: 3,
      textUnderlineOffset: 10,
    }}
  >
    {children}
  </span>
);

const TitleCard: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <div style={{position: "absolute", inset: 0}}>
      <Grid />
      <TopRule />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 445,
          textAlign: "center",
          opacity: fade(frame, 15, 45),
          translate: `0 ${interpolate(frame, [15, 45], [18, 0], clamp)}px`,
        }}
      >
        <div style={{fontFamily: serif, fontSize: 92, color: "#f4f1e8", lineHeight: 1}}>
          Coodra
        </div>
        <div
          style={{
            marginTop: 34,
            fontFamily: mono,
            fontSize: 18,
            color: "#7dd87d",
            letterSpacing: 8,
            textTransform: "uppercase",
          }}
        >
          Give it a memory
        </div>
      </div>
      <Progress />
    </div>
  );
};

const UiShell: React.FC<{kind: (typeof chapters)[number]["mock"]}> = ({kind}) => {
  return (
    <div
      style={{
        width: 860,
        height: 590,
        border: "1px solid rgba(125,216,125,0.18)",
        background: "rgba(4,14,9,0.88)",
        display: "grid",
        gridTemplateColumns: "150px 1fr",
        color: "#e8e6e1",
        fontFamily: sans,
      }}
    >
      <div style={{borderRight: "1px solid rgba(125,216,125,0.14)", padding: 20}}>
        <div style={{display: "flex", alignItems: "center", gap: 8, color: "#e8e6e1", fontSize: 12, fontWeight: 700}}>
          <span style={{width: 14, height: 14, border: "1px solid #7dd87d", borderRadius: "50%", display: "inline-block"}} />
          Coodra
        </div>
        <div style={{marginTop: 34, fontSize: 9, color: "rgba(232,230,225,0.42)", textTransform: "uppercase", fontFamily: mono}}>
          This machine
        </div>
        <div style={{marginTop: 10, height: 38, border: "1px solid rgba(232,230,225,0.12)", color: "#777", padding: "12px 10px", fontSize: 10}}>
          All projects
        </div>
        {["Dashboard", "Runs", "Decisions", "Context packs", "Work packs", "Policies", "Deep Wiki", "Recipes"].map((item) => (
          <div
            key={item}
            style={{
              marginTop: 13,
              paddingLeft: 8,
              height: 17,
              color: activeFor(kind, item) ? "#e8e6e1" : "rgba(232,230,225,0.48)",
              borderLeft: activeFor(kind, item) ? "2px solid #7dd87d" : "2px solid transparent",
              fontSize: 11,
            }}
          >
            {item}
          </div>
        ))}
      </div>
      <div style={{padding: "28px 38px"}}>
        <div style={{display: "flex", justifyContent: "space-between", alignItems: "center"}}>
          <div style={{fontFamily: mono, fontSize: 11, color: "#7dd87d", textTransform: "uppercase"}}>
            /{kind === "work" ? "work packs" : kind}
          </div>
          <div style={{display: "flex", gap: 10}}>
            <div style={{width: 170, height: 24, border: "1px solid rgba(232,230,225,0.12)"}} />
            <div style={{width: 68, height: 24, border: "1px solid rgba(232,230,225,0.14)", color: "#aaa", fontFamily: mono, fontSize: 9, display: "grid", placeItems: "center"}}>DOCS</div>
            <div style={{width: 96, height: 24, background: "#7dd87d", color: "#020905", fontFamily: mono, fontSize: 9, display: "grid", placeItems: "center"}}>START</div>
          </div>
        </div>
        <MockContent kind={kind} />
      </div>
    </div>
  );
};

const activeFor = (kind: (typeof chapters)[number]["mock"], item: string) => {
  if (kind === "recipes") return item === "Recipes";
  if (kind === "packs" || kind === "session") return item === "Context packs";
  if (kind === "work") return item === "Work packs";
  if (kind === "wiki") return item === "Deep Wiki";
  return false;
};

const MockContent: React.FC<{kind: (typeof chapters)[number]["mock"]}> = ({kind}) => {
  if (kind === "session") {
    return (
      <>
        <MockHeadline>
          SessionStart injects <i><Underline>project memory</Underline></i>.
        </MockHeadline>
        <MockText>Recipe index, workflow policy, recent decisions, and context excerpts arrive before the first prompt.</MockText>
        <div style={{display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginTop: 54}}>
          {["Recipes", "Decisions", "Context Packs"].map((x) => <MiniCard key={x} title={x} tag="injected" />)}
        </div>
      </>
    );
  }
  if (kind === "recipes") {
    return (
      <>
        <MockHeadline>
          <Underline>Agent Recipes</Underline> pull <i>only what fits</i>.
        </MockHeadline>
        <MockText>Reusable guidance loads on demand. Work Packs stay separate: they are issue-bound records.</MockText>
        <div style={{display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginTop: 50}}>
          {["api-development", "security-audit", "plugin-building"].map((x) => <MiniCard key={x} title={x} tag="recipe" />)}
        </div>
      </>
    );
  }
  if (kind === "packs") {
    return (
      <>
        <MockHeadline>
          Every session, <i><Underline>recapped</Underline></i>.
        </MockHeadline>
        <MockText>Context Packs preserve decisions, changed files, test status, open TODOs, and links to Work Packs.</MockText>
        <Rows rows={["Context Pack saved", "Decision recorded", "Open TODO carried forward"]} />
      </>
    );
  }
  if (kind === "work") {
    return (
      <>
        <MockHeadline>
          <Underline>Work Packs</Underline> keep the <i>thread of work</i>.
        </MockHeadline>
        <MockText>Start from a Jira issue, PR, or manual pack. Resume later with the work state intact.</MockText>
        <Rows rows={["cood-12 plugin repair", "status: in progress", "latest pack linked"]} />
      </>
    );
  }
  return (
    <>
      <MockHeadline>
        <Underline>Deep Wiki</Underline>, <i>grounded in your graph</i>.
      </MockHeadline>
      <MockText>Graphify maps the codebase. The agent authors the wiki; Coodra stores and renders it.</MockText>
      <div style={{marginTop: 52, width: 250}}>
        <MiniCard title="coodra architecture wiki" tag="complete" />
      </div>
    </>
  );
};

const MockHeadline: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div
    style={{
      marginTop: 58,
      maxWidth: 640,
      fontFamily: serif,
      fontSize: 50,
      lineHeight: 1.05,
      color: "#f4f1e8",
    }}
  >
    {children}
  </div>
);

const MockText: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div style={{marginTop: 18, maxWidth: 570, fontSize: 15, lineHeight: 1.55, color: "rgba(232,230,225,0.62)"}}>
    {children}
  </div>
);

const MiniCard: React.FC<{title: string; tag: string}> = ({title, tag}) => (
  <div style={{border: "1px solid rgba(125,216,125,0.16)", background: "rgba(125,216,125,0.035)", padding: 20, height: 112}}>
    <div style={{fontFamily: mono, fontSize: 10, color: "#7dd87d", textTransform: "uppercase"}}>{tag}</div>
    <div style={{marginTop: 20, fontFamily: serif, fontSize: 25, color: "#e8e6e1", lineHeight: 1.1}}>{title}</div>
  </div>
);

const Rows: React.FC<{rows: string[]}> = ({rows}) => (
  <div style={{marginTop: 50, borderTop: "1px solid rgba(125,216,125,0.15)"}}>
    {rows.map((row) => (
      <div key={row} style={{height: 54, borderBottom: "1px solid rgba(125,216,125,0.12)", display: "flex", alignItems: "center", justifyContent: "space-between"}}>
        <span style={{fontFamily: mono, fontSize: 15, color: "#e8e6e1"}}>{row}</span>
        <span style={{fontFamily: mono, fontSize: 10, color: "#7dd87d", border: "1px solid rgba(125,216,125,0.35)", padding: "4px 8px"}}>OK</span>
      </div>
    ))}
  </div>
);

const FeatureScene: React.FC<{index: number}> = ({index}) => {
  const frame = useCurrentFrame();
  const chapter = chapters[index];

  return (
    <div style={{position: "absolute", inset: 0, overflow: "hidden"}}>
      <Grid />
      <TopRule />
      <Progress />
      <div style={{position: "absolute", left: 110, top: 50, color: "rgba(232,230,225,0.32)", fontFamily: mono, fontSize: 13, letterSpacing: 5}}>
        {chapter.chapter} / 07
      </div>
      <div style={{position: "absolute", left: 110, top: 390, width: 640}}>
        <div style={{color: "#7dd87d", fontFamily: mono, fontSize: 18, letterSpacing: 8, textTransform: "uppercase", opacity: fade(frame, 3, 20)}}>
          {chapter.label}
        </div>
        <div
          style={{
            marginTop: 36,
            fontFamily: serif,
            color: "#f4f1e8",
            fontSize: 78,
            lineHeight: 0.98,
            opacity: fade(frame, 12, 34),
            translate: `${interpolate(frame, [12, 34], [-28, 0], clamp)}px 0`,
          }}
        >
          {chapter.title[0]}
          <br />
          <Underline>
            <span style={{fontStyle: chapter.chapter === "04" ? "italic" : "normal", color: chapter.chapter === "04" ? "#7dd87d" : "#f4f1e8"}}>
              {chapter.title[1]}
            </span>
          </Underline>
        </div>
        <div
          style={{
            marginTop: 34,
            fontFamily: mono,
            fontSize: 16,
            color: "rgba(232,230,225,0.48)",
            opacity: fade(frame, 26, 46),
          }}
        >
          {chapter.note}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          right: 92,
          top: 250,
          opacity: fade(frame, 18, 42),
          scale: interpolate(frame, [18, 42], [0.965, 1], clamp),
          boxShadow: "0 0 80px rgba(0,0,0,0.25)",
        }}
      >
        <UiShell kind={chapter.mock} />
      </div>
    </div>
  );
};

const MetricsScene: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <div style={{position: "absolute", inset: 0}}>
      <Grid />
      <TopRule />
      <Progress />
      <div style={{position: "absolute", left: 0, right: 0, top: 425, display: "flex", justifyContent: "center", gap: 86}}>
        {[
          ["23+", "MCP tools"],
          ["5", "coding agents"],
          ["0", "required API keys"],
        ].map(([num, label], i) => (
          <div key={label} style={{width: 220, textAlign: "center", borderLeft: i > 0 ? "1px solid rgba(232,230,225,0.16)" : "none", opacity: fade(frame, 8 + i * 8, 30 + i * 8)}}>
            <div style={{fontFamily: serif, fontSize: 76, color: num === "0" ? "#7dd87d" : "#f4f1e8", lineHeight: 1}}>{num}</div>
            <div style={{marginTop: 24, fontFamily: mono, fontSize: 15, color: "rgba(232,230,225,0.46)", letterSpacing: 6, textTransform: "uppercase"}}>{label}</div>
          </div>
        ))}
      </div>
      <div style={{position: "absolute", left: 0, right: 0, top: 670, textAlign: "center", fontFamily: mono, color: "rgba(232,230,225,0.58)", letterSpacing: 6, textTransform: "uppercase", opacity: fade(frame, 48, 70)}}>
        local-first - MIT licensed
      </div>
    </div>
  );
};

const CtaScene: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <div style={{position: "absolute", inset: 0}}>
      <Grid />
      <TopRule />
      <Progress />
      <div style={{position: "absolute", left: 0, right: 0, top: 325, textAlign: "center", opacity: fade(frame, 8, 30)}}>
        <div style={{fontFamily: serif, fontSize: 82, color: "#f4f1e8", lineHeight: 1.15}}>
          Give your codebase
          <br />a <i style={{color: "#7dd87d"}}>memory</i>.
        </div>
        <div style={{margin: "44px auto 0", width: 480, border: "1px solid rgba(125,216,125,0.22)", background: "rgba(125,216,125,0.045)", color: "#f4f1e8", fontFamily: mono, fontSize: 23, padding: "20px 26px", textAlign: "left"}}>
          <span style={{color: "#7dd87d"}}>$</span> npm i -g @coodra/cli
        </div>
        <div style={{marginTop: 28, fontFamily: mono, fontSize: 15, color: "rgba(232,230,225,0.48)", letterSpacing: 4, textTransform: "uppercase"}}>
          coodra install - start - doctor - agent add - init
        </div>
      </div>
    </div>
  );
};

export const CoodraPromo30: React.FC = () => (
  <>
    <Audio src={staticFile("coodra-bg-music.wav")} volume={0.16} />
    <Sequence durationInFrames={4 * FPS} name="Title">
      <TitleCard />
    </Sequence>
    {chapters.map((_, index) => (
      <Sequence key={chapters[index].chapter} from={(4 + index * 4) * FPS} durationInFrames={4 * FPS} name={chapters[index].label}>
        <FeatureScene index={index} />
      </Sequence>
    ))}
    <Sequence from={24 * FPS} durationInFrames={3 * FPS} name="Metrics">
      <MetricsScene />
    </Sequence>
    <Sequence from={27 * FPS} durationInFrames={3 * FPS} name="CTA">
      <CtaScene />
    </Sequence>
  </>
);

export const coodraPromo30Config = {
  id: "CoodraPromo30",
  durationInFrames: 30 * FPS,
  fps: FPS,
  width: WIDTH,
  height: HEIGHT,
};
