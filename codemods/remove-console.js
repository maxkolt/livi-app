/**
 * Удаляет console.log/info/debug (оставляет warn/error)
 * Работает для JS/TS/TSX/JSX.
 */
export default function transformer(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);

  const isTargetConsole = (node) =>
    node &&
    node.callee &&
    node.callee.type === "MemberExpression" &&
    node.callee.object &&
    node.callee.object.name === "console" &&
    ["log", "info", "debug"].includes(node.callee.property?.name);

  // Удаляем отдельные выражения типа: console.log(...)
  root.find(j.ExpressionStatement, { expression: isTargetConsole })
      .remove();

  // Если лог стоит внутри последовательности/запятых: (a(), console.log(...), b())
  root.find(j.SequenceExpression).forEach(path => {
    const filtered = path.node.expressions.filter(expr => !isTargetConsole(expr));
    if (filtered.length !== path.node.expressions.length) {
      if (filtered.length === 0) {
        // Заменим на пустой литерал, а потом дропнется prettier'ом
        j(path).replaceWith(j.identifier("void 0"));
      } else {
        path.node.expressions = filtered;
      }
    }
  });

  return root.toSource({ quote: "single", trailingComma: true });
}

