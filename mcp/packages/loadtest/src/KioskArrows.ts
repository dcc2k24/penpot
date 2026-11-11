/** A point in page coordinates. */
export interface KioskPoint {
    /** Horizontal position. */
    x: number;
    /** Vertical position. */
    y: number;
}

/** The four ways the kiosk files draw a navigation arrow as a closed, filled outline. */
export type ArrowStyle = "triangle" | "barbs" | "dot-triangle" | "curved";

/** Every filled arrow style, in the order the plan cycles through them. */
export const ARROW_STYLES: readonly ArrowStyle[] = ["triangle", "barbs", "dot-triangle", "curved"];

/** A path that the plan can hand to `create_path`. */
export interface ArrowPath {
    /** Absolute SVG path data made of `M`, `L`, `C` and `Z` commands. */
    d: string;
    /** Box around every point of the path, controls included. */
    box: { x: number; y: number; width: number; height: number };
}

/** Width of an arrow shaft, in pixels. */
const SHAFT_HALF = 2;

/**
 * Rounds a coordinate to two decimals, so that the path text is short and stable.
 *
 * @param value - coordinate
 */
function round(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * Adds two vectors.
 *
 * @param a - first vector
 * @param b - second vector
 */
function add(a: KioskPoint, b: KioskPoint): KioskPoint {
    return { x: a.x + b.x, y: a.y + b.y };
}

/**
 * Scales a vector.
 *
 * @param a - vector
 * @param k - factor
 */
function mul(a: KioskPoint, k: number): KioskPoint {
    return { x: a.x * k, y: a.y * k };
}

/**
 * Unit vector from one point to another.
 *
 * @param from - start
 * @param to - end
 */
function direction(from: KioskPoint, to: KioskPoint): KioskPoint {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: dx / length, y: dy / length };
}

/**
 * Left-hand normal of a unit vector.
 *
 * @param u - unit vector
 */
function normal(u: KioskPoint): KioskPoint {
    return { x: -u.y, y: u.x };
}

/**
 * Writes a polygon as one closed sub-path.
 *
 * @param points - corners in order
 */
function polygon(points: readonly KioskPoint[]): string {
    const parts = points.map((p, i) => `${i === 0 ? "M" : "L"}${round(p.x)} ${round(p.y)}`);
    return `${parts.join("")}Z`;
}

/**
 * Writes a circle as one closed sub-path of four cubic curves.
 *
 * @param c - centre
 * @param r - radius
 */
function circlePath(c: KioskPoint, r: number): string {
    const k = 0.5523 * r;
    const f = (x: number, y: number): string => `${round(x)} ${round(y)}`;
    return (
        `M${f(c.x + r, c.y)}` +
        `C${f(c.x + r, c.y + k)} ${f(c.x + k, c.y + r)} ${f(c.x, c.y + r)}` +
        `C${f(c.x - k, c.y + r)} ${f(c.x - r, c.y + k)} ${f(c.x - r, c.y)}` +
        `C${f(c.x - r, c.y - k)} ${f(c.x - k, c.y - r)} ${f(c.x, c.y - r)}` +
        `C${f(c.x + k, c.y - r)} ${f(c.x + r, c.y - k)} ${f(c.x + r, c.y)}Z`
    );
}

/**
 * Box around a set of points.
 *
 * @param points - points to enclose
 */
function boxOf(points: readonly KioskPoint[]): ArrowPath["box"] {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x: round(x), y: round(y), width: round(Math.max(...xs) - x), height: round(Math.max(...ys) - y) };
}

/**
 * Builds the closed outline of an arrow that runs from the tail to the head. The outline is a filled shape, as the
 * design tools export a flattened arrow, not a stroked line.
 *
 * @param style - one of the four styles
 * @param tail - where the shaft starts
 * @param head - where the point of the arrowhead lies
 * @returns the path data and its box
 */
export function arrowOutline(style: ArrowStyle, tail: KioskPoint, head: KioskPoint): ArrowPath {
    const u = direction(tail, head);
    const n = normal(u);
    const w = SHAFT_HALF;
    const at = (base: KioskPoint, along: number, across: number): KioskPoint =>
        add(base, add(mul(u, along), mul(n, across)));
    if (style === "triangle") {
        const pts = [
            at(tail, 0, w),
            at(head, -18, w),
            at(head, -18, 9),
            head,
            at(head, -18, -9),
            at(head, -18, -w),
            at(tail, 0, -w),
        ];
        return { d: polygon(pts), box: boxOf(pts) };
    }
    if (style === "barbs") {
        const pts = [
            at(tail, 0, w),
            at(head, -16, w),
            at(head, -26, 11),
            head,
            at(head, -26, -11),
            at(head, -16, -w),
            at(tail, 0, -w),
        ];
        return { d: polygon(pts), box: boxOf(pts) };
    }
    if (style === "dot-triangle") {
        const start = at(tail, 3, 0);
        const pts = [
            at(start, 0, w),
            at(head, -18, w),
            at(head, -18, 9),
            head,
            at(head, -18, -9),
            at(head, -18, -w),
            at(start, 0, -w),
        ];
        const ring = [at(tail, -5, -5), at(tail, 5, 5)];
        return { d: `${circlePath(tail, 5)}${polygon(pts)}`, box: boxOf([...pts, ...ring]) };
    }
    // curved shaft: a quadratic centre line, turned into two cubic edges, then a straight triangular head
    const length = Math.hypot(head.x - tail.x, head.y - tail.y);
    const bend = Math.min(40, length * 0.18);
    const mid = add(mul(add(tail, head), 0.5), mul(n, bend));
    const endTangent = direction(mid, head);
    const base = add(head, mul(endTangent, -18));
    const control = add(mul(add(tail, base), 0.5), mul(n, bend * 2));
    const startNormal = normal(direction(tail, control));
    const endNormal = normal(endTangent);
    const edge = (side: number): [KioskPoint, KioskPoint, KioskPoint, KioskPoint] => {
        const p0 = add(tail, mul(startNormal, side * w));
        const q = add(control, mul(normal(direction(add(tail, base), control)), side * w));
        const p2 = add(base, mul(endNormal, side * w));
        const c1 = add(p0, mul({ x: q.x - p0.x, y: q.y - p0.y }, 2 / 3));
        const c2 = add(p2, mul({ x: q.x - p2.x, y: q.y - p2.y }, 2 / 3));
        return [p0, c1, c2, p2];
    };
    const [l0, l1, l2, l3] = edge(1);
    const [r0, r1, r2, r3] = edge(-1);
    const f = (p: KioskPoint): string => `${round(p.x)} ${round(p.y)}`;
    const headLeft = add(base, mul(endNormal, 9));
    const headRight = add(base, mul(endNormal, -9));
    const d =
        `M${f(l0)}C${f(l1)} ${f(l2)} ${f(l3)}L${f(headLeft)}L${f(head)}L${f(headRight)}L${f(r3)}` +
        `C${f(r2)} ${f(r1)} ${f(r0)}Z`;
    return { d, box: boxOf([l0, l1, l2, l3, headLeft, head, headRight, r0, r1, r2, r3]) };
}

/**
 * Builds the path of an open arrow: one line, or one curve, that the shape's stroke cap turns into an arrowhead.
 *
 * @param tail - where the line starts
 * @param head - where the line ends and the cap sits
 * @param curved - true for a cubic curve, false for a straight line
 * @returns the path data and its box
 */
export function openArrowPath(tail: KioskPoint, head: KioskPoint, curved: boolean): ArrowPath {
    const f = (p: KioskPoint): string => `${round(p.x)} ${round(p.y)}`;
    if (!curved) {
        return { d: `M${f(tail)}L${f(head)}`, box: boxOf([tail, head]) };
    }
    const n = normal(direction(tail, head));
    const bend = Math.min(40, Math.hypot(head.x - tail.x, head.y - tail.y) * 0.2);
    const c1 = add(add(mul(tail, 2 / 3), mul(head, 1 / 3)), mul(n, bend));
    const c2 = add(add(mul(tail, 1 / 3), mul(head, 2 / 3)), mul(n, -bend));
    return { d: `M${f(tail)}C${f(c1)} ${f(c2)} ${f(head)}`, box: boxOf([tail, c1, c2, head]) };
}
