export {
  type EnsureProjectConfigResult,
  ensureProjectConfig,
  PROJECT_CONFIG_REL,
  type ProjectConfig,
  projectConfigPath,
  readProjectConfig,
  type WriteProjectConfigOptions,
  writeProjectConfig,
} from './config.js';
export { ensureProjectLayout, PROJECT_DIR_RELS } from './layout.js';
export {
  type CleanupPolicy,
  classifyGeneratedPath,
  MANIFEST_REL,
  type Manifest,
  type ManifestEntry,
  type ManifestEntryInput,
  type ManifestScope,
  manifestPath,
  pruneManifestEntries,
  type RecordManifestOptions,
  readManifest,
  recordManifestEntries,
} from './manifest.js';
