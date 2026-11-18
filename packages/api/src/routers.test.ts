import { describe, expect, it } from "vitest";
import { RPCHandler } from "@orpc/server/fetch";
import router from "./routers/index";

describe("RPC router composition", () => {
	it("loads the language variant update procedure at the client RPC path", async () => {
		expect(router.resume.variants.update).toBeDefined();
		expect(router.resume.variants.update["~orpc"].route).toMatchObject({
			method: "PUT",
			path: "/resumes/{resumeId}/variants/{locale}",
		});
		expect(router.resume.variants.translate["~orpc"].route).toMatchObject({
			method: "POST",
			path: "/resumes/{resumeId}/variants/translate",
		});
		expect(router.resume.variants.translateBlock["~orpc"].route).toMatchObject({
			method: "POST",
			path: "/resumes/{resumeId}/variants/{locale}/blocks/translate",
		});

		const handler = new RPCHandler(router);
		const { response } = await handler.handle(
			new Request("http://localhost/api/rpc/resume/variants/update", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
			{
				prefix: "/api/rpc",
				context: { locale: "en-US", reqHeaders: new Headers(), resHeaders: new Headers() },
			},
		);

		expect(response).toBeDefined();
		expect(response?.status).not.toBe(404);
	});
});
