/**
 * Converts the attribute names that backend-mode tools accept into the kebab-case names of the backend.
 *
 * Tools take camelCase names such as `parentId`, and the backend answers to kebab-case attributes such as
 * `parent-id`. Every capital starts a new word, so `layoutItemHSizing` becomes `layout-item-h-sizing`.
 * Names that are already kebab-case pass through unchanged.
 */
export class BackendFieldNames {
    /**
     * Converts each attribute name to kebab-case.
     *
     * @param names - attribute names, in camelCase or kebab-case
     * @returns the same names in kebab-case, in the same order
     */
    public toBackendFields(names: string[]): string[] {
        return names.map((name) => this.toKebabCase(name));
    }

    /**
     * Converts one attribute name to kebab-case.
     *
     * @param name - attribute name, in camelCase or kebab-case
     */
    private toKebabCase(name: string): string {
        return name.replace(/[A-Z]/g, (letter, offset: number) =>
            offset === 0 ? letter.toLowerCase() : `-${letter.toLowerCase()}`
        );
    }
}
