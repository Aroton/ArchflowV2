/**
 * Wraps the shipped ProjectionWriter with the two process-death cuts used by the
 * transaction crash child. The kill callback remains child-private; this fixture
 * only preserves the writer's three-operation surface.
 */
export function createCrashProjectionWriter(writer, cutPoint, killAtCut) {
  const apply = async (path, callback) => {
    if (cutPoint === "projection-replace-before") {
      await killAtCut(cutPoint, path.absolute);
    }
    await callback();
    if (cutPoint === "projection-replace-after") {
      await killAtCut(cutPoint, path.absolute);
    }
  };

  return Object.freeze({
    replaceRegular: (path, bytes, executable) =>
      apply(path, () => writer.replaceRegular(path, bytes, executable)),
    replaceSymlink: (path, target) =>
      apply(path, () => writer.replaceSymlink(path, target)),
    remove: (path) => apply(path, () => writer.remove(path)),
  });
}
