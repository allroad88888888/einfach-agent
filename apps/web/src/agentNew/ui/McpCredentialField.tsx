/**
 * 一个凭据字段（headers 或 env）在设置表单里的输入控件（C2）。
 *
 * 【为什么单独拆出来】McpAddServerForm.tsx 要在 http/stdio 两个分支各摆一个这样的字段
 * （headers、env），字段本身除了文案和 aria-label 之外完全同构：多行 KEY=VALUE 文本框 +
 * 一句格式提示 + 一句「浏览器不支持」提示 + 校验错误。拆成组件避免表单文件重复这套结构，
 * 也让 McpAddServerForm.tsx 不必再顶着两份几乎一样的 JSX 逼近文件行数上限。
 *
 * 【为什么是明文 textarea，不是 type="password"】textarea 原生不支持 password 型遮挡；
 * 而且这里存的是多行「键=值」，用户保存前需要能看清自己填的键名有没有拼错、值有没有多余的
 * 空格——遮挡多行结构化内容只会让核对变得不可能。这份文本本来就不会进 localStorage
 * （宿主不支持凭据时输入框直接禁用，见下面 disabled；宿主支持时它只活在这个受控组件的
 * React state 和内存里的 draft atom 中，落盘只发生在桌面配置文件），明文展示的风险
 * 因此局限在「这台机器上能看到这块屏幕的人」，与用户填写时肉眼核对的需求相比是合理取舍。
 */
export function McpCredentialField({
  id,
  label,
  value,
  placeholder,
  formatHint,
  disabled,
  disabledHint,
  error,
  onChange,
}: {
  id: string
  label: string
  value: string
  placeholder: string
  /** 启用时常驻显示的格式说明。 */
  formatHint: string
  disabled: boolean
  /** 禁用时替代 formatHint 显示的说明（凭据仅桌面端支持）。 */
  disabledHint: string
  error?: string
  onChange: (value: string) => void
}) {
  return (
    <label className="agentnew-mcp-form-wide" htmlFor={id}>
      <span>{label}</span>
      <textarea
        id={id}
        className="agentnew-settings-textarea"
        value={value}
        rows={3}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      />
      <small>{disabled ? disabledHint : formatHint}</small>
      {error ? <small role="alert">{error}</small> : null}
    </label>
  )
}
