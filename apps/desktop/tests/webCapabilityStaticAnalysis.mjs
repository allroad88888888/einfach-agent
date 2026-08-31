import path from 'node:path'
import ts from 'typescript'

const trustedPluginEntry = path.join('plugins', 'pluginImportModule.ts')

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function isTransparentExpression(node) {
  return ts.isParenthesizedExpression(node)
    || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node)
    || ts.isSatisfiesExpression(node)
    || ts.isNonNullExpression(node)
    || ts.isPartiallyEmittedExpression(node)
}

function unwrapExpression(node) {
  let current = node
  while (current && isTransparentExpression(current)) current = current.expression
  return current
}

function outerTransparentExpression(node) {
  let current = node
  while (current.parent && isTransparentExpression(current.parent) && current.parent.expression === current) {
    current = current.parent
  }
  return current
}

function literalText(node, resolveIdentifier = () => undefined) {
  const expression = unwrapExpression(node)
  if (ts.isStringLiteralLike(expression)) return expression.text
  if (ts.isIdentifier(expression)) return resolveIdentifier(expression)
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalText(expression.left, resolveIdentifier)
    const right = literalText(expression.right, resolveIdentifier)
    return left === undefined || right === undefined ? undefined : left + right
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text
    for (const span of expression.templateSpans) {
      const valuePart = literalText(span.expression, resolveIdentifier)
      if (valuePart === undefined) return undefined
      value += valuePart + span.literal.text
    }
    return value
  }
  return undefined
}

function loadedModule(node, resolveIdentifier) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    && node.moduleSpecifier
  ) return { name: literalText(node.moduleSpecifier, resolveIdentifier) }
  if (
    ts.isImportEqualsDeclaration(node)
    && ts.isExternalModuleReference(node.moduleReference)
    && node.moduleReference.expression
  ) return { name: literalText(node.moduleReference.expression, resolveIdentifier) }
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return undefined
  const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
  const requireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require'
  const requireResolve = ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'require'
    && node.expression.name.text === 'resolve'
  return dynamicImport || requireCall || requireResolve
    ? { name: literalText(node.arguments[0], resolveIdentifier) }
    : undefined
}

function containsTauriHostKind(type) {
  if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) return type.literal.text === 'tauri'
  return ts.isUnionTypeNode(type) && type.types.some(containsTauriHostKind)
}

function trustedPluginArrow(file, webSourceRoot, node) {
  if (path.relative(webSourceRoot, file) !== trustedPluginEntry) return undefined
  if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined
  if (node.arguments.length !== 1 || !ts.isIdentifier(node.arguments[0])) return undefined

  const arrow = outerTransparentExpression(node).parent
  if (!ts.isArrowFunction(arrow) || arrow.body !== outerTransparentExpression(node)) return undefined
  if (
    arrow.parameters.length !== 1
    || !ts.isIdentifier(arrow.parameters[0].name)
    || arrow.parameters[0].name.text !== 'url'
    || node.arguments[0].text !== arrow.parameters[0].name.text
  ) return undefined

  const arrowContainer = outerTransparentExpression(arrow)
  const fallback = arrowContainer.parent
  if (
    !ts.isBinaryExpression(fallback)
    || fallback.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
    || fallback.right !== arrowContainer
  ) return undefined
  const initializer = outerTransparentExpression(fallback)
  const declaration = initializer.parent
  if (
    !ts.isVariableDeclaration(declaration)
    || declaration.initializer !== initializer
    || !ts.isIdentifier(declaration.name)
    || declaration.name.text !== 'evaluate'
  ) return undefined
  return arrow
}

function computedLoaderName(node, resolveIdentifier) {
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    return literalText(node.argumentExpression, resolveIdentifier)
  }
  if (ts.isComputedPropertyName(node)) return literalText(node.expression, resolveIdentifier)
  return undefined
}

function isUnprovenComputedGlobalAccess(node, resolveIdentifier) {
  if (!ts.isElementAccessExpression(node) || !node.argumentExpression) return false
  const target = unwrapExpression(node.expression)
  return ts.isIdentifier(target)
    && ['globalThis', 'window', 'self'].includes(target.text)
    && literalText(node.argumentExpression, resolveIdentifier) === undefined
}

function createBindingResolver(file, text) {
  const normalizedFile = path.resolve(file)
  const options = { allowJs: true, noLib: true, noResolve: true, target: ts.ScriptTarget.Latest }
  const host = ts.createCompilerHost(options)
  const originalGetSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => (
    path.resolve(name) === normalizedFile
      ? ts.createSourceFile(normalizedFile, text, languageVersion, true, scriptKind(file))
      : originalGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile)
  )
  host.fileExists = (name) => path.resolve(name) === normalizedFile
  host.readFile = (name) => path.resolve(name) === normalizedFile ? text : undefined
  const program = ts.createProgram([normalizedFile], options, host)
  const source = program.getSourceFile(normalizedFile)
  const checker = program.getTypeChecker()
  const mutated = new Set()

  const collectWrittenSymbols = (target) => {
    const node = unwrapExpression(target)
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node)
      if (symbol) mutated.add(symbol)
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) collectWrittenSymbols(element)
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          const symbol = checker.getShorthandAssignmentValueSymbol(property)
          if (symbol) mutated.add(symbol)
          else collectWrittenSymbols(property.name)
        }
        else if (ts.isPropertyAssignment(property)) collectWrittenSymbols(property.initializer)
        else if (ts.isSpreadAssignment(property)) collectWrittenSymbols(property.expression)
      }
    } else if (ts.isSpreadElement(node)) {
      collectWrittenSymbols(node.expression)
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      collectWrittenSymbols(node.left)
    }
  }
  const collectMutations = (node) => {
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      collectWrittenSymbols(node.left)
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      collectWrittenSymbols(node.operand)
    } else if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node))
      && !ts.isVariableDeclarationList(node.initializer)
    ) {
      collectWrittenSymbols(node.initializer)
    }
    ts.forEachChild(node, collectMutations)
  }
  collectMutations(source)

  const resolving = new Set()
  const resolveIdentifier = (identifier) => {
    const symbol = checker.getSymbolAtLocation(identifier)
    const declaration = symbol?.valueDeclaration
    if (
      !symbol
      || resolving.has(symbol)
      || mutated.has(symbol)
      || !declaration
      || !ts.isVariableDeclaration(declaration)
      || !declaration.initializer
      || declaration.getStart(source) >= identifier.getStart(source)
      || !(ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const)
    ) return undefined
    resolving.add(symbol)
    const value = literalText(declaration.initializer, resolveIdentifier)
    resolving.delete(symbol)
    return value
  }
  return { source, resolveIdentifier }
}

export function inspectWebSource(file, text, webSourceRoot) {
  const { source, resolveIdentifier } = createBindingResolver(file, text)
  const violations = []

  const trustedArrows = new Set()
  const visit = (node) => {
    const loaded = loadedModule(node, resolveIdentifier)
    const moduleName = loaded?.name
    if (loaded && moduleName === undefined) {
      const trustedArrow = trustedPluginArrow(file, webSourceRoot, node)
      if (trustedArrow) trustedArrows.add(trustedArrow)
      else violations.push('loads a non-static module outside the trusted plugin entry')
    }
    if (moduleName?.startsWith('@tauri-apps/')) violations.push('loads @tauri-apps')
    if (moduleName === 'child_process' || moduleName === 'node:child_process') {
      violations.push('loads child_process')
    }
    if (ts.isIdentifier(node) && node.text === 'require') violations.push('uses require loader')
    if (computedLoaderName(node, resolveIdentifier) === 'require') violations.push('uses computed require loader')
    if (isUnprovenComputedGlobalAccess(node, resolveIdentifier)) {
      violations.push('uses an unproven computed global property')
    }
    if (
      (ts.isIdentifier(node) && node.text === '__TAURI__')
      || (ts.isStringLiteralLike(node) && node.text === '__TAURI__')
    ) violations.push('accesses global Tauri API')
    if (computedLoaderName(node, resolveIdentifier) === '__TAURI__') {
      violations.push('accesses computed global Tauri API')
    }
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'HostKind' && containsTauriHostKind(node.type)) {
      violations.push('adds tauri to HostKind')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (path.relative(webSourceRoot, file) === trustedPluginEntry && trustedArrows.size !== 1) {
    violations.push('trusted plugin entry must contain exactly one direct import(url) bound to its arrow parameter')
  }
  return [...new Set(violations)]
}
