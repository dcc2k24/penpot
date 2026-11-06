/**
 * One dispatched event of a `text/event-stream` body.
 */
export class ServerSentEvent {
    /**
     * Creates a dispatched event.
     *
     * @param name - event name from the `event:` field, or `message` when the frame has none
     * @param data - event data, with the `data:` lines of the frame joined by newlines
     */
    constructor(
        public readonly name: string,
        public readonly data: string
    ) {}
}

/**
 * Reader for the events of a `text/event-stream` body.
 */
export class ServerSentEvents {
    /** Event name of a frame that carries no `event:` field. */
    public static readonly DEFAULT_EVENT_NAME = "message";

    /**
     * Returns the dispatched events of a stream body, in order.
     *
     * Multi-line `data:` fields of one event are joined with newlines. A frame without an `event:` field
     * is named `message`. A trailing event without a blank line terminator still counts. Comment lines
     * and other fields are ignored.
     *
     * @param body - complete stream body text
     * @returns the events in the order they appear, empty when the body holds none
     */
    public static parse(body: string): ServerSentEvent[] {
        const events: ServerSentEvent[] = [];
        let name: string | undefined;
        let data: string[] = [];
        for (const line of body.split(/\r?\n/)) {
            if (line === "") {
                ServerSentEvents.dispatch(events, name, data);
                name = undefined;
                data = [];
            } else if (line.startsWith("event:")) {
                name = ServerSentEvents.fieldValue(line, "event:");
            } else if (line.startsWith("data:")) {
                data.push(ServerSentEvents.fieldValue(line, "data:"));
            }
        }
        ServerSentEvents.dispatch(events, name, data);
        return events;
    }

    /**
     * Adds an event to the list when its frame carried any data lines.
     *
     * @param events - list that receives the event
     * @param name - event name of the frame, or undefined when the frame had no `event:` field
     * @param data - data lines of the frame
     */
    private static dispatch(events: ServerSentEvent[], name: string | undefined, data: string[]): void {
        if (data.length === 0) {
            return;
        }
        const eventName = name === undefined || name === "" ? ServerSentEvents.DEFAULT_EVENT_NAME : name;
        events.push(new ServerSentEvent(eventName, data.join("\n")));
    }

    /**
     * Returns the value of a field line, without the field prefix and one optional leading space.
     *
     * @param line - the field line
     * @param prefix - the field name followed by a colon
     */
    private static fieldValue(line: string, prefix: string): string {
        return line.slice(prefix.length).replace(/^ /, "");
    }
}
