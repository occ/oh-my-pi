import * as path from "node:path";
import { expandTilde } from "../tools/path-utils";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { Settings } from "../config/settings";
import { cfgExtensions } from "../extensibility/settings";

/** Keep invocation authority while rebinding only project-configured roots to a child checkout. */
export async function rebaseSubagentExtensionRoots(
	roots: EffectiveExtensionRoots | undefined,
	settings: Settings,
	parentCwd: string,
	cwd: string,
): Promise<EffectiveExtensionRoots | undefined> {
	if (!roots) return roots;
	const explicit = roots.explicit.map(entry => path.resolve(parentCwd, expandTilde(entry)));
	if (roots.configuredLevel !== "project") return { ...roots, explicit };
	const childSettings = await settings.cloneForCwd(cwd);
	return {
		explicit,
		mode: roots.mode,
		configured: cfgExtensions.get(childSettings),
		configuredLevel: childSettings.extensionsSourceLevel(),
	};
}
