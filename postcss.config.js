import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

const unwrapStandaloneTailwindLayers = {
  postcssPlugin: 'unwrap-standalone-tailwind-layers',
  Once(root) {
    const source = root.toString();
    if (source.includes('@tailwind')) return;

    root.walkAtRules('layer', (rule) => {
      if (!['base', 'components', 'utilities'].includes(rule.params)) return;
      rule.replaceWith(...rule.nodes);
    });
  },
};

export default {
  plugins: [unwrapStandaloneTailwindLayers, tailwindcss(), autoprefixer()],
};
