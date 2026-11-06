import type { DesignModel, NodeModel } from "./DesignModel.js";

/** Attribute that the generator puts on the element of every design node, and the comparator reads back. */
export const NODE_ID_ATTRIBUTE = "data-node-id";

/** Viewport at which every screen and component is rendered and compared. */
export const VIEWPORT = { width: 1440, height: 900 } as const;

/**
 * Viewport of the pixel screenshots. It is 16 px larger than VIEWPORT in each direction: the app body has the browser
 * margin of 8 px, so a board at 1440 by 900 otherwise runs past the viewport and its edge is cut off.
 */
export const PIXEL_VIEWPORT = { width: 1456, height: 916 } as const;

/** Name of the Components page of the design file. */
export const COMPONENTS_PAGE_NAME = "Components";

/** Prefix that every journey page name starts with. */
const JOURNEY_PREFIX = "Journey: ";

/** Separator between the journey and the screen in a screen board name. */
const NAME_SEPARATOR = " / ";

/** One journey screen: a board on a "Journey: <name>" page. */
export interface ScreenTarget {
    /** Kind of target, always "screen". */
    readonly kind: "screen";
    /** Stable id, "<journey-slug>/<screen-slug>", for example "onboarding/welcome". */
    readonly id: string;
    /** Name of the journey, the page name without "Journey: ", for example "Onboarding". */
    readonly journey: string;
    /** Name of the screen, the last part of the board name, for example "Welcome". */
    readonly screen: string;
    /** Full board name, for example "Onboarding / Welcome". */
    readonly name: string;
    /** Id of the page that holds the board. */
    readonly pageId: string;
    /** Name of the page, for example "Journey: Onboarding". */
    readonly pageName: string;
    /** The screen board, a top-level node of the page. */
    readonly board: NodeModel;
    /** Route of the app, "/<journey-slug>/<screen-slug>". */
    readonly route: string;
    /** Path of the generated route module, relative to app/src, for example "screens/Onboarding/Welcome.tsx". */
    readonly modulePath: string;
    /** Name of the generated React component, for example "OnboardingWelcome". */
    readonly componentName: string;
}

/** One design component of the library, rendered from its main board on the Components page. */
export interface ComponentTarget {
    /** Kind of target, always "component". */
    readonly kind: "component";
    /** Stable id, the full name of the component, for example "Button/Primary/SM". */
    readonly id: string;
    /** Full name as the library holds it, for example "Button/Primary/SM". */
    readonly name: string;
    /** Id of the main board of the component. */
    readonly mainBoardId: string;
    /** The main board, a top-level node of the Components page. */
    readonly board: NodeModel;
    /** Route of the app, "/components/<slug>", for example "/components/button-primary-sm". */
    readonly route: string;
    /** Path of the generated component module, relative to app/src, for example "components/ButtonPrimarySM.tsx". */
    readonly modulePath: string;
    /** Name of the generated React component, for example "ButtonPrimarySM". */
    readonly componentName: string;
}

/** Any target that the app renders and the comparator checks. */
export type DesignTarget = ScreenTarget | ComponentTarget;

/**
 * Turns a name into a lower case slug. Runs of characters other than a-z and 0-9 become one dash, and no dash stays at
 * either end.
 *
 * @param name - name to turn into a slug
 */
export function toSlug(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/**
 * Turns a name into PascalCase. Each run of letters and digits starts with a capital letter, and the other characters
 * are dropped, so "Button/Primary/SM" becomes "ButtonPrimarySM".
 *
 * @param name - name to convert
 */
export function toPascal(name: string): string {
    return name
        .split(/[^A-Za-z0-9]+/)
        .filter((part) => part !== "")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");
}

/**
 * Returns the screen name of a board name: the part after the last " / ", or the whole name when there is none.
 *
 * @param boardName - name of a journey board, for example "Onboarding / Welcome"
 */
export function screenNameOf(boardName: string): string {
    const index = boardName.lastIndexOf(NAME_SEPARATOR);
    return index < 0 ? boardName : boardName.slice(index + NAME_SEPARATOR.length);
}

/**
 * Lists the screens of a model: every top-level board of every "Journey: " page, in page order and board order.
 *
 * @param model - pulled design model
 * @throws Error when two screens get the same id
 */
export function screenTargets(model: DesignModel): ScreenTarget[] {
    const targets: ScreenTarget[] = [];
    const ids = new Set<string>();
    for (const page of model.pages) {
        if (!page.name.startsWith(JOURNEY_PREFIX)) {
            continue;
        }
        const journey = page.name.slice(JOURNEY_PREFIX.length);
        for (const board of page.boards) {
            const screen = screenNameOf(board.name);
            const id = `${toSlug(journey)}/${toSlug(screen)}`;
            if (ids.has(id)) {
                throw new Error(`duplicate screen id ${id}`);
            }
            ids.add(id);
            targets.push({
                kind: "screen",
                id,
                journey,
                screen,
                name: board.name,
                pageId: page.id,
                pageName: page.name,
                board,
                route: `/${id}`,
                modulePath: `screens/${toPascal(journey)}/${toPascal(screen)}.tsx`,
                componentName: `${toPascal(journey)}${toPascal(screen)}`,
            });
        }
    }
    return targets;
}

/**
 * Lists the design components of a model, sorted by full name by code units. Each one is matched with its main board
 * on the Components page.
 *
 * @param model - pulled design model
 * @throws Error when the Components page is missing, a main board is missing, or two components get the same name
 */
export function componentTargets(model: DesignModel): ComponentTarget[] {
    const componentsPage = model.pages.find((page) => page.name === COMPONENTS_PAGE_NAME);
    if (componentsPage === undefined) {
        throw new Error(`no page named ${COMPONENTS_PAGE_NAME}`);
    }
    const sorted = [...model.components].sort((a, b) => compareCodeUnits(a.fullName, b.fullName));
    const names = new Set<string>();
    return sorted.map((component) => {
        const board = componentsPage.boards.find((candidate) => candidate.id === component.mainInstanceId);
        if (board === undefined) {
            throw new Error(
                `main board ${component.mainInstanceId} of ${component.fullName} is not on the Components page`
            );
        }
        const componentName = toPascal(component.fullName);
        if (names.has(componentName)) {
            throw new Error(`duplicate component name ${componentName}`);
        }
        names.add(componentName);
        return {
            kind: "component",
            id: component.fullName,
            name: component.fullName,
            mainBoardId: component.mainInstanceId,
            board,
            route: `/components/${toSlug(component.fullName)}`,
            modulePath: `components/${componentName}.tsx`,
            componentName,
        };
    });
}

/**
 * Lists every target of a model: the components first, then the screens.
 *
 * @param model - pulled design model
 */
export function allTargets(model: DesignModel): DesignTarget[] {
    return [...componentTargets(model), ...screenTargets(model)];
}

/**
 * Compares two strings by their UTF-16 code units, so that the order does not depend on the locale.
 *
 * @param a - first string
 * @param b - second string
 */
function compareCodeUnits(a: string, b: string): number {
    if (a === b) {
        return 0;
    }
    return a < b ? -1 : 1;
}
