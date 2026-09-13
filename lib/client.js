/**
 * dsh-3301 — DSH browser half: the collapsible settings card for the LAN gate.
 *
 * Loaded by the client module system as a `window.__ModuleLoader__.load(...)`
 * module, so this file is hand-written in that shape instead of being bundled.
 *
 * Styling mirrors the shipped plugin cards exactly: the same structural classes
 * (card / header / name / description / chevron / body / field / label / input /
 * footer) with the same declarations and the same theme tokens
 * (`--dsw-alias-*`) as `PluginCard.module.css` and `fields.module.css` in
 * `@deepseek-ai/dsh-client-ui-settings-plugins`. Like those bundles, this file
 * injects its own stylesheet once, which is what makes hover, focus and
 * transitions behave like the rest of Settings.
 *
 * It also uses the shared client primitives the shipped cards use for their
 * controls (`@deepseek-ai/dsh-client-ui-primitives`: `Switch`, `Tag`, chevron),
 * degrading to plain elements if a primitive is unavailable.
 *
 * The card is keyed by the settings namespace the Host half registers
 * (`dsh-3301`) inside the `settings.plugin.item` slot, so it appears at
 * Settings → Plugins → Plugin configuration. Tunables are written through the
 * settings scope; the password is never read or written as a value — it is
 * posted once to the gate's loopback-only endpoint, which stores a scrypt
 * verifier on the Host side.
 */
window.__ModuleLoader__.load({
	id: "dsh-3301",
	factory: (require) => {
		const React = require("react");
		const primitives = (() => {
			try {
				return require("@deepseek-ai/dsh-client-ui-primitives") ?? {};
			} catch {
				return {};
			}
		})();

		const name = "dsh-3301";
		/** Client services this half reads. */
		const inject = ["slots"];
		/** Settings namespace owned by the Host half. */
		const NAMESPACE = "dsh-3301";
		const DEFAULT_PORT = 3301;
		const STYLE_ID = "dsh-3301/card.css";

		/** Preset options; 30 days / 5 failures / 5 minutes are the defaults. */
		const SESSION_DAY_OPTIONS = [1, 3, 7, 15, 30, 90, 180, 365];
		const FAILURE_OPTIONS = [3, 5, 10, 20];
		const LOCKOUT_OPTIONS = [1, 5, 15, 30, 60];
		const HOST_OPTIONS = [
			{ value: "0.0.0.0", label: "0.0.0.0（局域网可达）" },
			{ value: "127.0.0.1", label: "127.0.0.1（仅本机）" },
		];

		const LABELS = {
			title: "dsh-3301 局域网入口",
			enabled: "启用入口",
			host: "监听地址",
			port: "监听端口",
			username: "用户名",
			sessionDays: "安全验证周期",
			maxFailures: "失败次数上限",
			lockoutMinutes: "锁定时长",
			bootstrap: "注入客户端兜底",
			save: "保存",
			saved: "已保存",
			password: "口令",
			passwordSet: "已设置",
			passwordUnset: "未设置",
			updatedAt: "上次修改",
			current: "当前口令",
			next: "新口令",
			changePassword: "修改口令",
			changing: "提交中…",
			loopbackOnly: "口令只能在本机（运行 DSH 的机器）修改；手机上的此卡片为只读。",
			passwordHint: "只存 scrypt 校验子，不存明文。新口令留空 = 清除口令（入口将不再校验口令）。",
			dayUnit: "天",
			timesUnit: "次",
			minuteUnit: "分钟",
		};

		/**
		 * Same declarations as the shipped `PluginCard.module.css` and
		 * `fields.module.css`, renamed to this plugin's own classes.
		 */
		const CSS = `
.dx-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}
.dx-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dx-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dx-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dx-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dx-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dx-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dx-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dx-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.dx-chevronOpen{transform:rotate(180deg)}
.dx-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.dx-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.dx-field+.dx-field{border-top:.5px solid var(--dsw-alias-border-l2)}
.dx-head{align-items:center;gap:8px;display:flex}
.dx-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.dx-badges{align-items:center;gap:8px;display:inline-flex}
.dx-input{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}
.dx-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dx-trigger{display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;text-align:left}
.dx-relative{position:relative}
.dx-popup{position:absolute;top:calc(100% + 4px);left:0;right:0;max-height:240px;overflow-y:auto;padding:4px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);box-shadow:0 8px 24px rgba(0,0,0,.35);z-index:30}
.dx-option{display:block;width:100%;padding:7px 10px;border:0;border-radius:8px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;text-align:left;cursor:pointer}
.dx-option:hover{background:var(--dsw-alias-bg-layer-3)}
.dx-optionActive{background:var(--dsw-alias-bg-layer-3);font-weight:600}
.dx-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.dx-toggleRow{color:var(--dsw-alias-label-primary);justify-content:space-between;align-items:flex-start;gap:16px;font-size:13px;line-height:1.5;display:flex}
.dx-toggleLabel{flex:1;min-width:0}
.dx-footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.dx-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.dx-save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dx-save:hover:not(:disabled){opacity:.9}
.dx-save:disabled{opacity:.4;cursor:default}
`;

		/** Inject this card's stylesheet once, the way the shipped bundles do. */
		function ensureStyle() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-3301";
			tag.dataset.pluginCss = STYLE_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ── helpers ────────────────────────────────────────────────────────────
		/** Pick the resolved namespace value out of whatever shape the scope exposes. */
		function resolvedOf(snapshot) {
			if (snapshot === null || typeof snapshot !== "object") return {};
			if (snapshot.value !== null && typeof snapshot.value === "object") return snapshot.value;
			if (snapshot.resolved !== null && typeof snapshot.resolved === "object") return snapshot.resolved;
			return snapshot;
		}

		/** Presets plus the current value when it is outside the presets, so an
		 * externally-set value is never displayed as a preset it is not. */
		const withCurrent = (values, current, format) => {
			const options = values.map(format);
			return options.some((option) => option.value === current) ? options : [...options, format(current)];
		};
		const hostOptions = (current) =>
			HOST_OPTIONS.some((option) => option.value === current) ? HOST_OPTIONS : [...HOST_OPTIONS, { value: current, label: current }];

		const days = (value) => ({ value: Number(value), label: `${value} ${LABELS.dayUnit}${Number(value) === 30 ? "（默认）" : ""}` });
		const times = (value) => ({ value: Number(value), label: `${value} ${LABELS.timesUnit}` });
		const minutes = (value) => ({ value: Number(value), label: `${value} ${LABELS.minuteUnit}` });

		/** The shared `Tag` primitive for badges, else a plain span. */
		function Badge(props) {
			return typeof primitives.Tag === "function"
				? React.createElement(primitives.Tag, null, props.children)
				: React.createElement("span", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" } }, props.children);
		}

		/** The shared chevron, rotated when open; falls back to a text caret. */
		function Chevron(props) {
			return primitives.IconChevronDownOutline14 !== undefined
				? React.createElement(primitives.IconChevronDownOutline14, { className: `dx-chevron${props.open ? " dx-chevronOpen" : ""}` })
				: React.createElement("span", { className: `dx-chevron${props.open ? " dx-chevronOpen" : ""}` }, "▾");
		}

		/** One field: label row (with optional badges) above the control. */
		function Field(props) {
			return React.createElement(
				"div",
				{ className: "dx-field" },
				React.createElement(
					"div",
					{ className: "dx-head" },
					React.createElement("span", { className: "dx-label" }, props.label),
					props.badges ? React.createElement("span", { className: "dx-badges" }, props.badges) : null
				),
				props.children
			);
		}

		function TextInput(props) {
			return React.createElement("input", {
				className: "dx-input",
				type: props.type ?? "text",
				value: props.value === undefined || props.value === null ? "" : String(props.value),
				placeholder: props.placeholder,
				onChange: (event) => props.onChange(props.type === "number" ? Number(event.target.value) : event.target.value),
			});
		}

		function BoolInput(props) {
			return typeof primitives.Switch === "function"
				? React.createElement(primitives.Switch, {
						checked: props.value === true,
						label: props.label,
						onChange: (next) => props.onChange(typeof next === "boolean" ? next : !(props.value === true)),
					})
				: React.createElement("input", {
						type: "checkbox",
						checked: props.value === true,
						onChange: (event) => props.onChange(event.target.checked),
					});
		}

		/** Boolean field: label left, switch right — the shipped cards' toggle row. */
		function ToggleField(props) {
			return React.createElement(
				"div",
				{ className: "dx-field" },
				React.createElement(
					"div",
					{ className: "dx-toggleRow" },
					React.createElement("span", { className: "dx-toggleLabel" }, props.label),
					React.createElement(BoolInput, { value: props.value, label: props.label, onChange: props.onChange })
				)
			);
		}

		/** Dropdown styled exactly like the official text input, plus a list. */
		function Dropdown(props) {
			const [open, setOpen] = React.useState(false);
			const boxRef = React.useRef(null);

			React.useEffect(() => {
				if (!open) return undefined;
				const close = (event) => {
					if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false);
				};
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("mousedown", close);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("mousedown", close);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);

			const current = props.options.find((option) => option.value === props.value) ?? props.options[0];
			return React.createElement(
				"div",
				{ ref: boxRef, className: "dx-relative" },
				React.createElement(
					"button",
					{
						type: "button",
						className: "dx-input dx-trigger",
						"aria-haspopup": "listbox",
						"aria-expanded": open,
						onClick: () => setOpen((previous) => !previous),
					},
					React.createElement("span", null, current?.label ?? ""),
					React.createElement(Chevron, { open })
				),
				open
					? React.createElement(
							"div",
							{ className: "dx-popup", role: "listbox" },
							props.options.map((option) =>
								React.createElement(
									"button",
									{
										key: String(option.value),
										type: "button",
										className: `dx-option${option.value === props.value ? " dx-optionActive" : ""}`,
										onClick: () => {
											props.onChange(option.value);
											setOpen(false);
										},
									},
									option.label
								)
							)
						)
					: null
			);
		}

		// ── card ───────────────────────────────────────────────────────────────
		function SettingsCard(props) {
			const { scope } = props;
			const [open, setOpen] = React.useState(false);
			const [draft, setDraft] = React.useState(() => resolvedOf(scope.getSnapshot()));
			const [status, setStatus] = React.useState({ state: "loading" });
			const [notice, setNotice] = React.useState("");
			const [passwordForm, setPasswordForm] = React.useState({ current: "", next: "" });
			// The gate listens on the configured port on this machine; follow edits live.
			const gateOrigin = `http://127.0.0.1:${Number(draft.port ?? DEFAULT_PORT) || DEFAULT_PORT}`;

			React.useEffect(() => {
				const sync = () => setDraft(resolvedOf(scope.getSnapshot()));
				if (typeof scope.subscribe === "function") return scope.subscribe(sync);
				if (typeof scope.on === "function") return scope.on("change", sync);
				return undefined;
			}, [scope]);

			const refreshStatus = React.useCallback(() => {
				fetch(`${gateOrigin}/__gate/status`, { headers: { accept: "application/json" } })
					.then((response) => response.json().then((payload) => ({ ok: response.ok, payload })))
					.then(({ ok, payload }) => setStatus(ok ? { state: "ready", ...payload } : { state: "error", error: payload?.error }))
					.catch((error) => setStatus({ state: "error", error: String(error.message ?? error) }));
			}, [gateOrigin]);

			React.useEffect(() => {
				if (open) refreshStatus();
			}, [open, refreshStatus]);

			const set = (key) => (value) => setDraft((previous) => ({ ...previous, [key]: value }));

			const save = () => {
				const ops = [
					{ op: "set", path: ["enabled"], value: draft.enabled !== false },
					{ op: "set", path: ["host"], value: String(draft.host ?? "0.0.0.0") },
					{ op: "set", path: ["port"], value: Number(draft.port ?? DEFAULT_PORT) },
					{ op: "set", path: ["username"], value: String(draft.username ?? "dsh") },
					{ op: "set", path: ["sessionDays"], value: Number(draft.sessionDays ?? 30) },
					{ op: "set", path: ["maxFailures"], value: Number(draft.maxFailures ?? 5) },
					{ op: "set", path: ["lockoutMinutes"], value: Number(draft.lockoutMinutes ?? 5) },
					{ op: "set", path: ["injectClientBootstrap"], value: draft.injectClientBootstrap !== false },
				];
				Promise.resolve(scope.mutate(ops))
					.then(() => {
						setNotice(LABELS.saved);
						refreshStatus();
					})
					.catch((error) => setNotice(String(error?.message ?? error)));
			};

			/** An empty new password is the removal path, not an error. */
			const clearMode = passwordForm.next === "";
			const changePassword = () => {
				setNotice(LABELS.changing);
				fetch(`${gateOrigin}/__gate/password`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ current: passwordForm.current, next: passwordForm.next }),
				})
					.then((response) => response.json().then((payload) => ({ ok: response.ok, payload })))
					.then(({ ok, payload }) => {
						setNotice(ok ? (clearMode ? "口令已清除（入口不再校验口令）" : "口令已更新") : `失败：${payload?.error ?? "未知错误"}`);
						if (ok) {
							setPasswordForm({ current: "", next: "" });
							refreshStatus();
						}
					})
					.catch((error) => setNotice(`失败：${String(error.message ?? error)}（入口未在运行？）`));
			};

			const enabled = draft.enabled !== false;
			/** Operator-supplied hint from the settings namespace; empty unless set. */
			const hint = String(draft.passwordHint ?? "");
			const summary = `${String(draft.host ?? "0.0.0.0")}:${String(draft.port ?? DEFAULT_PORT)} · ${String(draft.sessionDays ?? 30)} 天`;

			const header = React.createElement(
				"button",
				{ type: "button", className: "dx-header", "aria-expanded": open, onClick: () => setOpen((previous) => !previous) },
				React.createElement(
					"span",
					{ className: "dx-headText" },
					React.createElement("span", { className: "dx-name" }, LABELS.title),
					React.createElement("span", { className: "dx-description" }, summary)
				),
				React.createElement(Chevron, { open })
			);

			const body = React.createElement(
				"div",
				{ className: "dx-body" },
				React.createElement(ToggleField, { label: LABELS.enabled, value: enabled, onChange: set("enabled") }),
				React.createElement(
					Field,
					{ label: LABELS.host },
					React.createElement(Dropdown, {
						value: String(draft.host ?? "0.0.0.0"),
						options: hostOptions(String(draft.host ?? "0.0.0.0")),
						onChange: set("host"),
					})
				),
				React.createElement(Field, { label: LABELS.port }, React.createElement(TextInput, { type: "number", value: draft.port ?? DEFAULT_PORT, onChange: set("port") })),
				React.createElement(Field, { label: LABELS.username }, React.createElement(TextInput, { value: draft.username ?? "dsh", onChange: set("username") })),
				React.createElement(
					Field,
					{ label: LABELS.sessionDays },
					React.createElement(Dropdown, {
						value: Number(draft.sessionDays ?? 30),
						options: withCurrent(SESSION_DAY_OPTIONS, Number(draft.sessionDays ?? 30), days),
						onChange: set("sessionDays"),
					})
				),
				React.createElement(
					Field,
					{ label: LABELS.maxFailures },
					React.createElement(Dropdown, {
						value: Number(draft.maxFailures ?? 5),
						options: withCurrent(FAILURE_OPTIONS, Number(draft.maxFailures ?? 5), times),
						onChange: set("maxFailures"),
					})
				),
				React.createElement(
					Field,
					{ label: LABELS.lockoutMinutes },
					React.createElement(Dropdown, {
						value: Number(draft.lockoutMinutes ?? 5),
						options: withCurrent(LOCKOUT_OPTIONS, Number(draft.lockoutMinutes ?? 5), minutes),
						onChange: set("lockoutMinutes"),
					})
				),
				React.createElement(ToggleField, {
					label: LABELS.bootstrap,
					value: draft.injectClientBootstrap !== false,
					onChange: set("injectClientBootstrap"),
				}),
				React.createElement(
					"div",
					{ className: "dx-footer" },
					notice === "" ? null : React.createElement("p", { className: "dx-failed" }, notice),
					React.createElement("button", { type: "button", className: "dx-save", onClick: save }, LABELS.save)
				),
				React.createElement(
					Field,
					{
						label: LABELS.password,
						badges: React.createElement(Badge, null, status.state === "ready" ? (status.set ? LABELS.passwordSet : LABELS.passwordUnset) : "…"),
					},
					status.state === "ready"
						? React.createElement(
								React.Fragment,
								null,
								status.set && status.updatedAt
									? React.createElement("p", { className: "dx-hint", style: { margin: "0 0 6px" } }, `${LABELS.updatedAt} ${String(status.updatedAt).slice(0, 19).replace("T", " ")}`)
									: null,
								React.createElement("div", { style: { marginBottom: "8px" } },
									React.createElement(TextInput, {
										type: "password",
										placeholder: LABELS.current,
										value: passwordForm.current,
										onChange: (value) => setPasswordForm((form) => ({ ...form, current: value })),
									})
								),
								React.createElement("div", { style: { marginBottom: "8px" } },
									React.createElement(TextInput, {
										type: "password",
										placeholder: LABELS.next,
										value: passwordForm.next,
										onChange: (value) => setPasswordForm((form) => ({ ...form, next: value })),
									})
								),
								React.createElement(
									"div",
									{ className: "dx-footer" },
									React.createElement("button", { type: "button", className: "dx-save", onClick: changePassword }, clearMode ? "清除口令" : LABELS.changePassword)
								)
							)
						: React.createElement("p", { className: "dx-hint" }, status.state === "error" ? LABELS.loopbackOnly : "…"),
					React.createElement("p", { className: "dx-hint" }, `${LABELS.passwordHint}${hint === "" ? "" : ` · ${hint}`}`)
				),
				React.createElement("p", { className: "dx-hint" }, LABELS.loopbackOnly)
			);

			return React.createElement("li", { className: `dx-card${open ? " dx-cardOpen" : ""}` }, header, open ? body : null);
		}

		function apply(ctx) {
			ensureStyle();
			ctx.inject(["settingsScope"], (scoped) => {
				const scope = scoped.settingsScope.bind({ namespace: NAMESPACE });
				scoped.slots.inject("settings.plugin.item", () =>
					scoped.slots.register({ name: "settings.plugin.item", key: NAMESPACE, locale: undefined, inject: () => ({}) }, () =>
						React.createElement(SettingsCard, { scope })
					)
				);
			});
		}

		return { name, inject, apply };
	},
});
