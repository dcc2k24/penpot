/**
 * Reads response bodies with a byte cap, so that one answer cannot exhaust the memory of the server.
 */
export class CappedBody {
    /**
     * Reads the whole body as bytes, refusing bodies over the cap.
     *
     * A declared Content-Length over the cap is refused before any byte is read. Otherwise the bytes are
     * counted while they stream in, and the read stops as soon as the count passes the cap.
     *
     * @param response - response whose body is still unread
     * @param maxBytes - largest body accepted, in bytes
     * @param overflow - builds the error thrown for a body over the cap
     * @returns the body bytes, empty when the response has no body
     * @throws Error built by `overflow` when the body is over the cap
     */
    public static async bytes(response: Response, maxBytes: number, overflow: () => Error): Promise<Uint8Array> {
        const declared = response.headers.get("content-length");
        if (declared !== null && Number(declared) > maxBytes) {
            await response.body?.cancel();
            throw overflow();
        }
        if (response.body === null) {
            return new Uint8Array(0);
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        let result = await reader.read();
        while (!result.done) {
            total += result.value.byteLength;
            if (total > maxBytes) {
                await reader.cancel();
                throw overflow();
            }
            chunks.push(result.value);
            result = await reader.read();
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes;
    }
}
