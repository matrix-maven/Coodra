import {Audio, Sequence, staticFile} from "remotion";
import {ContextLayer} from "./scenes/ContextLayer";
import {Guardrails} from "./scenes/Guardrails";
import {Install} from "./scenes/Install";
import {MemoryLoop} from "./scenes/MemoryLoop";
import {Opening} from "./scenes/Opening";
import {fps} from "./theme";

export const CoodraPromo: React.FC = () => {
  return (
    <>
      <Audio src={staticFile("coodra-promo.wav")} />
      <Sequence durationInFrames={5 * fps} name="Opening">
        <Opening />
      </Sequence>
      <Sequence from={5 * fps} durationInFrames={5 * fps} name="Context layer">
        <ContextLayer />
      </Sequence>
      <Sequence from={10 * fps} durationInFrames={5 * fps} name="Memory loop">
        <MemoryLoop />
      </Sequence>
      <Sequence from={15 * fps} durationInFrames={4 * fps} name="Guardrails">
        <Guardrails />
      </Sequence>
      <Sequence from={19 * fps} durationInFrames={6 * fps} name="Install">
        <Install />
      </Sequence>
    </>
  );
};
