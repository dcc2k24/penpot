/**
 * Maps the shape types `ellipse` and `board` between the caller and the backend.
 *
 * The backend stores an ellipse as type `circle`. Callers see and send `ellipse`. The adapter also accepts
 * `circle` from callers.
 *
 * The backend stores a board as type `frame`. Every write tool calls it a board, so callers may send `board`.
 * Results keep the name `frame`, which is the same type. The adapter also accepts `frame` from callers.
 *
 * Every other shape type keeps its name.
 */
export class BackendShapeTypes {
    /**
     * Converts a backend type to the caller's type: `circle` becomes `ellipse`.
     *
     * @param type - a shape type as the backend names it
     */
    public static toCallerType(type: string): string {
        return type === "circle" ? "ellipse" : type;
    }

    /**
     * Converts a caller's type to the backend's type: `ellipse` becomes `circle` and `board` becomes `frame`.
     *
     * @param type - a shape type as the caller names it
     */
    public static toBackendType(type: string): string {
        if (type === "ellipse") {
            return "circle";
        }
        if (type === "board") {
            return "frame";
        }
        return type;
    }

    /**
     * Returns a shape with its type in the caller's form. A value without a string type passes through.
     *
     * @param shape - a shape object from the backend
     */
    public static toCallerShape(shape: unknown): unknown {
        if (typeof shape !== "object" || shape === null) {
            return shape;
        }
        const type = (shape as { type?: unknown }).type;
        if (typeof type !== "string") {
            return shape;
        }
        const callerType = BackendShapeTypes.toCallerType(type);
        return callerType === type ? shape : { ...shape, type: callerType };
    }

    /**
     * Returns a tree node with its type, and the type of every node below it, in the caller's form.
     *
     * @param node - a tree node from the backend, with its children nested under `children`
     */
    public static toCallerTree(node: unknown): unknown {
        const mapped = BackendShapeTypes.toCallerShape(node);
        if (typeof mapped !== "object" || mapped === null) {
            return mapped;
        }
        const children = (mapped as { children?: unknown }).children;
        if (!Array.isArray(children)) {
            return mapped;
        }
        return { ...mapped, children: children.map((child) => BackendShapeTypes.toCallerTree(child)) };
    }
}
