import { FONT_CATALOG } from "./FontCatalog";
import { TOKEN_WRITE_RULE } from "./ApplyTokenValues";
import { PropertyMap } from "./PropertyMap";
import { API_SOURCE } from "./facade/ApiSource";
import { CORE_SOURCE } from "./facade/CoreSource";
import { UTILS_SOURCE } from "./facade/UtilsSource";

/**
 * Builds the source that the sandbox evaluates once, before the first script runs.
 */
export class Prelude {
    /**
     * Returns the full prelude: the property table, the token write rule, the font catalogue, the core facade, the
     * Plugin API layer and the penpotUtils layer, in that order.
     *
     * @returns JavaScript source to evaluate in the guest
     */
    public static build(): string {
        return (
            "var PROPERTY_MAP = " +
            JSON.stringify(PropertyMap.toJsonTable()) +
            ";\n" +
            "var TOKEN_WRITE_RULE = " +
            JSON.stringify(TOKEN_WRITE_RULE) +
            ";\n" +
            "var FONT_CATALOG = " +
            JSON.stringify(FONT_CATALOG) +
            ";\n" +
            CORE_SOURCE +
            "\n" +
            API_SOURCE +
            "\n" +
            UTILS_SOURCE
        );
    }
}
