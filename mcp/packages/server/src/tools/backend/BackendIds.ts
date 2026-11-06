import { z } from "zod";

/**
 * Zod schemas for Penpot ids in backend-mode tools.
 *
 * Ids are checked with a pattern instead of zod's RFC-strict `uuid()`, which rejects the nil UUID that
 * Penpot uses as the page root id.
 */
export class BackendIds {
    /** Penpot ids in canonical 8-4-4-4-12 hexadecimal form. */
    private static readonly PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

    /**
     * Returns a schema for one Penpot id.
     */
    public static uuid(): z.ZodString {
        return z.string().regex(BackendIds.PATTERN, "must be a UUID such as 3f2c1a9e-0b7d-4c1e-9a55-2d6f0e8b7c10");
    }
}
