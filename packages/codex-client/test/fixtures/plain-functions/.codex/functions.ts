export default {
	helloDashboard: {
		description: "Return a dashboard greeting.",
		sideEffects: "read-only",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string" },
			},
			additionalProperties: false,
		},
		tags: ["dashboard"],
		examples: [
			{
				params: { name: "Peezy" },
				result: { greeting: "Hello, Peezy" },
			},
		],
		handler: async (params = {}) => {
			const input = params as { name?: unknown };
			const name = typeof input.name === "string" ? input.name : "dashboard";
			return { greeting: `Hello, ${name}` };
		},
	},
};
