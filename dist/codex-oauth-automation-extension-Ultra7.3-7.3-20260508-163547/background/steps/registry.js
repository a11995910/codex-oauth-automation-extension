(function attachBackgroundStepRegistry(root, factory) {
  root.MultiPageBackgroundStepRegistry = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundStepRegistryModule() {
  function createStepRegistry(definitions = []) {
    const ordered = (Array.isArray(definitions) ? definitions : [])
      .map((definition) => ({
        id: Number(definition?.id),
        order: Number(definition?.order),
        key: String(definition?.key || '').trim(),
        title: String(definition?.title || '').trim(),
        execute: definition?.execute,
      }))
      .filter((definition) => Number.isFinite(definition.id) && typeof definition.execute === 'function')
      .sort((left, right) => {
        const leftOrder = Number.isFinite(left.order) ? left.order : left.id;
        const rightOrder = Number.isFinite(right.order) ? right.order : right.id;
        return leftOrder - rightOrder;
      });

    const byId = new Map(ordered.map((definition) => [definition.id, definition]));

    function getStepDefinition(step) {
      return byId.get(Number(step)) || null;
    }

    function getOrderedSteps() {
      return ordered.slice();
    }

    function executeStep(step, state) {
      const definition = getStepDefinition(step);
      if (!definition) {
        throw new Error(`未知步骤：${step}`);
      }
      return definition.execute(state);
    }

    return {
      executeStep,
      getOrderedSteps,
      getStepDefinition,
    };
  }

  return {
    createStepRegistry,
  };
});
