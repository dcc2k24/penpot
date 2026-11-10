import * as yaml from "js-yaml";
import * as fs from "fs";
import * as path from "path";

/**
 * Represents a single type/interface defined in the Penpot API
 */
export class ApiType {
    private readonly name: string;
    private readonly overview: string;
    private readonly members: Record<string, Record<string, string>>;
    private cachedFullText: string | null = null;

    constructor(name: string, overview: string, members: Record<string, Record<string, string>>) {
        this.name = name;
        this.overview = overview;
        this.members = members;
    }

    /**
     * Returns the original name of this API type.
     */
    getName(): string {
        return this.name;
    }

    /**
     * Returns the overview text of this API type (which all signature/type declarations)
     */
    getOverviewText() {
        return this.overview;
    }

    /**
     * Creates a single markdown text document from all parts of this API type.
     *
     * The full text is cached within the object for performance.
     */
    getFullText(): string {
        if (this.cachedFullText === null) {
            let text = this.overview;

            for (const [memberType, memberEntries] of Object.entries(this.members)) {
                text += `\n\n## ${memberType}\n`;

                for (const [memberName, memberDescription] of Object.entries(memberEntries)) {
                    text += `\n### ${memberName}\n\n${memberDescription}`;
                }
            }

            this.cachedFullText = text;
        }

        return this.cachedFullText;
    }

    /**
     * Returns the names of all members, in document order.
     */
    getMemberNames(): string[] {
        return Object.values(this.members).flatMap((memberEntries) => Object.keys(memberEntries));
    }

    /**
     * Returns the description of the member with the given name.
     *
     * The member type doesn't matter for the search, as member names are unique
     * across all member types within a single API type. An exact match wins; otherwise
     * the name is matched without regard to letter case.
     */
    getMember(memberName: string): string | null {
        for (const memberEntries of Object.values(this.members)) {
            if (Object.prototype.hasOwnProperty.call(memberEntries, memberName)) {
                return memberEntries[memberName];
            }
        }
        const wanted = memberName.toLowerCase();
        for (const name of this.getMemberNames()) {
            if (name.toLowerCase() === wanted) {
                return this.getMember(name);
            }
        }
        return null;
    }
}

/**
 * Loads and manages API documentation from YAML files.
 *
 * This class provides case-insensitive access to API type documentation
 * loaded from the data/api_types.yml file, and to topics loaded from the
 * data/api_topics.yml file. A topic explains a subject that is not an API type,
 * such as the geometry of shapes.
 */
export class ApiDocs {
    private readonly apiTypes: Map<string, ApiType> = new Map();
    private readonly topics: Map<string, ApiType> = new Map();

    /**
     * Creates a new ApiDocs instance and loads the API types and the topics from the YAML files.
     */
    constructor() {
        this.loadEntries("api_types.yml", this.apiTypes);
        this.loadEntries("api_topics.yml", this.topics);
    }

    /**
     * Loads entries from a YAML file in the data directory into the given map.
     *
     * @param fileName - name of the file in the data directory
     * @param target - map that receives the entries, keyed by lower-case name
     */
    private loadEntries(fileName: string, target: Map<string, ApiType>): void {
        const yamlPath = path.join(process.cwd(), "data", fileName);
        const yamlContent = fs.readFileSync(yamlPath, "utf8");
        const data = yaml.load(yamlContent) as Record<string, any>;

        for (const [typeName, typeData] of Object.entries(data)) {
            const overview = typeData.overview || "";
            const members = typeData.members || {};

            const apiType = new ApiType(typeName, overview, members);

            // store with lower-case key for case-insensitive retrieval
            target.set(typeName.toLowerCase(), apiType);
        }
    }

    /**
     * Retrieves an API type by name (case-insensitive).
     */
    getType(typeName: string): ApiType | null {
        return this.apiTypes.get(typeName.toLowerCase()) || null;
    }

    /**
     * Retrieves a topic by name (case-insensitive).
     */
    getTopic(topicName: string): ApiType | null {
        return this.topics.get(topicName.toLowerCase()) || null;
    }

    /**
     * Returns all topic names.
     */
    getTopicNames(): string[] {
        return Array.from(this.topics.values()).map((topic) => topic.getName());
    }

    /**
     * Returns all available type names.
     */
    getTypeNames(): string[] {
        return Array.from(this.apiTypes.values()).map((type) => type.getName());
    }

    /**
     * Returns the number of loaded API types.
     */
    getTypeCount(): number {
        return this.apiTypes.size;
    }
}
