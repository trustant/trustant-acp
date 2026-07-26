const SENSITIVE_KEY =
	/(?:authorization|api[_-]?key|token|password|passwd|pwd|secret|credential|connection[_-]?string)/i;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactSensitiveText(
	value: string,
	knownSecrets: readonly string[] = [],
): string {
	let result = value;
	for (const secret of [...knownSecrets].sort(
		(left, right) => right.length - left.length,
	)) {
		if (secret.length >= 4) {
			result = result.replace(
				new RegExp(escapeRegExp(secret), "g"),
				"[REDACTED]",
			);
		}
	}
	return result
		.replace(
			/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi,
			"$1[REDACTED]@",
		)
		.replace(
			/\b(authorization|api[_-]?key|token|password|passwd|pwd|secret|credential)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
			"$1$2[REDACTED]",
		)
		.replace(
			/(["'](?:authorization|api[_-]?key|token|password|passwd|pwd|secret|credential|connection[_-]?string)["']\s*:\s*)(["'])[^"']*\2/gi,
			"$1$2[REDACTED]$2",
		);
}

export function redactSensitiveValue<T>(
	value: T,
	knownSecrets: readonly string[] = [],
	key = "",
): T {
	if (typeof value === "string") {
		return (SENSITIVE_KEY.test(key)
			? "[REDACTED]"
			: redactSensitiveText(value, knownSecrets)) as T;
	}
	if (Array.isArray(value)) {
		return value.map((entry) =>
			redactSensitiveValue(entry, knownSecrets),
		) as T;
	}
	if (value && typeof value === "object") {
		const output: Record<string, unknown> = {};
		for (const [entryKey, entryValue] of Object.entries(value)) {
			output[entryKey] = redactSensitiveValue(
				entryValue,
				knownSecrets,
				entryKey,
			);
		}
		return output as T;
	}
	return value;
}
