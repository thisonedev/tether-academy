export declare const docs: import("fumadocs-mdx/config").DocsCollection<import("zod").ZodObject<{
    title: import("zod").ZodString;
    description: import("zod").ZodOptional<import("zod").ZodString>;
    icon: import("zod").ZodOptional<import("zod").ZodString>;
    full: import("zod").ZodOptional<import("zod").ZodBoolean>;
    _openapi: import("zod").ZodOptional<import("zod").ZodObject<{}, import("zod/v4/core").$loose>>;
    sourceExample: import("zod").ZodOptional<import("zod").ZodString>;
    sourceExampleHash: import("zod").ZodOptional<import("zod").ZodString>;
    noSync: import("zod").ZodOptional<import("zod").ZodBoolean>;
    hints: import("zod").ZodOptional<import("zod").ZodArray<import("zod").ZodString>>;
    expectedOutput: import("zod").ZodOptional<import("zod").ZodArray<import("zod").ZodString>>;
    tests: import("zod").ZodOptional<import("zod").ZodArray<import("zod").ZodObject<{
        id: import("zod").ZodString;
        description: import("zod").ZodString;
        pattern: import("zod").ZodOptional<import("zod").ZodString>;
        contains: import("zod").ZodOptional<import("zod").ZodString>;
    }, import("zod/v4/core").$strip>>>;
    platforms: import("zod").ZodOptional<import("zod").ZodArray<import("zod").ZodEnum<{
        node: "node";
        web: "web";
        mobile: "mobile";
        desktop: "desktop";
    }>>>;
}, import("zod/v4/core").$strip>, import("zod").ZodObject<{
    title: import("zod").ZodOptional<import("zod").ZodString>;
    pages: import("zod").ZodOptional<import("zod").ZodArray<import("zod").ZodString>>;
    description: import("zod").ZodOptional<import("zod").ZodString>;
    root: import("zod").ZodOptional<import("zod").ZodBoolean>;
    defaultOpen: import("zod").ZodOptional<import("zod").ZodBoolean>;
    icon: import("zod").ZodOptional<import("zod").ZodString>;
}, import("zod/v4/core").$strip>, false>;
//# sourceMappingURL=source.config.d.ts.map