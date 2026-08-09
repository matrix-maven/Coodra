import {Composition, Folder} from "remotion";
import {CoodraAgentsPromo, coodraAgentsPromoConfig} from "./CoodraAgentsPromo";
import {CoodraPromo} from "./CoodraPromo";
import {CoodraPromo30, coodraPromo30Config} from "./CoodraPromo30";
import {ContextLayer} from "./scenes/ContextLayer";
import {Guardrails} from "./scenes/Guardrails";
import {Install} from "./scenes/Install";
import {MemoryLoop} from "./scenes/MemoryLoop";
import {Opening} from "./scenes/Opening";
import {durationInFrames, fps, height, width} from "./theme";

export const MyComposition = () => {
  return (
    <>
      <Folder name="CoodraPromo-Scenes">
        <Composition id="Opening" component={Opening} durationInFrames={5 * fps} fps={fps} width={width} height={height} />
        <Composition id="ContextLayer" component={ContextLayer} durationInFrames={5 * fps} fps={fps} width={width} height={height} />
        <Composition id="MemoryLoop" component={MemoryLoop} durationInFrames={5 * fps} fps={fps} width={width} height={height} />
        <Composition id="Guardrails" component={Guardrails} durationInFrames={4 * fps} fps={fps} width={width} height={height} />
        <Composition id="Install" component={Install} durationInFrames={6 * fps} fps={fps} width={width} height={height} />
      </Folder>
      <Composition
        id="CoodraLinkedInPromo"
        component={CoodraPromo}
        durationInFrames={durationInFrames}
        fps={fps}
        width={width}
        height={height}
      />
      <Composition
        id={coodraPromo30Config.id}
        component={CoodraPromo30}
        durationInFrames={coodraPromo30Config.durationInFrames}
        fps={coodraPromo30Config.fps}
        width={coodraPromo30Config.width}
        height={coodraPromo30Config.height}
      />
      <Composition
        id={coodraAgentsPromoConfig.id}
        component={CoodraAgentsPromo}
        durationInFrames={coodraAgentsPromoConfig.durationInFrames}
        fps={coodraAgentsPromoConfig.fps}
        width={coodraAgentsPromoConfig.width}
        height={coodraAgentsPromoConfig.height}
      />
    </>
  );
};
