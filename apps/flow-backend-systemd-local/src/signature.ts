import { createHmac, timingSafeEqual } from "node:crypto";

export function signBody(secret: string, body: string): string {
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifyBodySignature(secret: string, body: string, signature: string | null): boolean {
	if (!signature?.startsWith("sha256=")) {
		return false;
	}
	const expected = Buffer.from(signBody(secret, body));
	const actual = Buffer.from(signature);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function requestSignature(headers: Headers): string | null {
	return headers.get("x-flow-signature-256") ?? headers.get("x-patch-flow-signature-256") ?? headers.get("x-patchbay-flow-signature-256");
}
