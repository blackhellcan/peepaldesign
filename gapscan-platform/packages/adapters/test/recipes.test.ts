import test from 'node:test';
import assert from 'node:assert/strict';
import {typescriptObservations, variantRecipes} from '@gapscan/adapters';

test('cva recipes give a component its variants, sizes and Tailwind-styled states', () => {
  const source = `import { cva, type VariantProps } from "class-variance-authority"
const buttonVariants = cva("inline-flex hover:opacity-90 focus-visible:ring-2 disabled:opacity-50", {
  variants: { variant: { primary: "bg-blue-600", quiet: "bg-transparent" }, size: { sm: "h-8", lg: "h-10" }, block: { true: "w-full", false: "" } },
  defaultVariants: { variant: "primary", size: "sm" },
})
function Button({ className, variant, ...props }: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  return <button data-slot="button" className={buttonVariants({ variant, className })} {...props} />
}
export { Button, buttonVariants }`;
  const [api] = variantRecipes(source, 'button.tsx');
  assert.equal(api!.name, 'Button', 'named after the component that uses the recipe');
  assert.deepEqual(api!.variants, ['primary', 'quiet']);
  assert.deepEqual(api!.sizes, ['sm', 'lg']);
  assert.deepEqual(api!.props.find(p => p.name === 'block'), {name: 'block', type: 'boolean', optional: true});
  assert.deepEqual(api!.states.sort(), ['disabled', 'focus-visible', 'hover']);
});

test('Chakra recipes and tailwind-variants are read the same way; plain data-slot components are kept', () => {
  const chakra = `const tagRecipe = defineRecipe({ className: "chakra-tag", base: { _hover: { bg: "gray.100" }, _disabled: { opacity: 0.5 } },
    variants: { variant: { subtle: {}, solid: {}, outline: {} }, size: { sm: {}, md: {} } } })`;
  const [tag] = variantRecipes(chakra, 'tag.js');
  assert.deepEqual([tag!.name, tag!.variants, tag!.states.sort()], ['Tag', ['subtle', 'solid', 'outline'], ['disabled', 'hover']]);
  const tv = `const card = tv({ base: "rounded-lg", variants: { tone: { neutral: "", brand: "" } } })`;
  assert.deepEqual(variantRecipes(tv, 'card.ts')[0]!.variants, ['tone=neutral', 'tone=brand']);
  const input = `function Input({ className, ...props }: React.ComponentProps<"input">) {
    return <input data-slot="input" className={cn("border focus-visible:ring aria-invalid:border-red-500 disabled:opacity-50", className)} {...props} />
  }
  export { Input }`;
  const observed = typescriptObservations(input, 'input.tsx');
  assert.deepEqual(observed.map(o => o.type === 'component' ? [o.name, o.states?.sort()] : null), [['Input', ['disabled', 'error', 'focus-visible']]]);
  assert.deepEqual(variantRecipes('const x = 1', 'x.ts'), [], 'files without recipes or data-slot are untouched');
});
