import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const SERVICE_CONSTRUCTOR_NAME = /^make[A-Z]/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

function configuredPackageAliases(option: unknown): string[] {
	if (
		typeof option !== "object" ||
		option === null ||
		!("packageAliases" in option)
	) {
		return [];
	}
	const configured = option.packageAliases;
	if (!Array.isArray(configured)) return [];
	return configured.filter(
		(alias): alias is string =>
			typeof alias === "string" && alias.length > 0,
	);
}

function isProjectLocalImport(
	source: string,
	packageAliases: readonly string[],
): boolean {
	if (source.startsWith("./") || source.startsWith("../")) return true;
	return packageAliases.some(
		(alias) =>
			source === alias ||
			source.startsWith(alias.endsWith("/") ? alias : `${alias}/`),
	);
}

function getImportedName(specifier: ESTree.ImportSpecifier): string {
	if (specifier.imported.type === "Identifier") return specifier.imported.name;
	return specifier.imported.value;
}

/** Keep dependency-bearing Effect service constructors local to their owning capability modules. */
export const noServiceConstructorImportsRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow project-local make<CapabilityName> imports outside test and spec files. Relative imports always count as project-local; additional bare-specifier prefixes can be listed via the packageAliases option.",
		},
		messages: {
			serviceConstructorImport:
				'Do not import Effect service constructor "{{name}}" into runtime code. Import the owning Layer, yield the contextual service, and allow its requirements to propagate to the composition root.',
		},
		schema: [
			{
				type: "object",
				properties: {
					packageAliases: {
						type: "array",
						items: { type: "string", minLength: 1 },
						uniqueItems: true,
					},
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ packageAliases: [] }],
	},
	create(context) {
		const packageAliases = configuredPackageAliases(context.options?.[0]);
		const isTestFile = TEST_FILE.test(context.filename.replaceAll("\\", "/"));

		return {
			ImportDeclaration(node) {
				if (
					isTestFile ||
					!isProjectLocalImport(node.source.value, packageAliases)
				)
					return;

				for (const specifier of node.specifiers) {
					if (specifier.type !== "ImportSpecifier") continue;

					const importedName = getImportedName(specifier);
					if (!SERVICE_CONSTRUCTOR_NAME.test(importedName)) continue;

					context.report({
						node: specifier,
						messageId: "serviceConstructorImport",
						data: { name: importedName },
					});
				}
			},
		};
	},
});
