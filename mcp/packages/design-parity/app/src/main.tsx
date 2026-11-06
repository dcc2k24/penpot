import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { IndexPage, routes } from "./routes.js";

/**
 * Chooses the page for a path: the index page, the render of a generated route, or a short not-found line.
 *
 * @param path - location path of the browser
 */
function pageFor(path: string): ReactElement {
    if (path === "/") {
        return <IndexPage />;
    }
    const route = routes.find((candidate) => candidate.path === path);
    if (route !== undefined) {
        return route.render();
    }
    return <p>Not found: {path}</p>;
}

const container = document.getElementById("root");
if (container === null) {
    throw new Error("missing root element");
}
createRoot(container).render(pageFor(window.location.pathname));
