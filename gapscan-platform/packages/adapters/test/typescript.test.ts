import test from 'node:test';
import assert from 'node:assert/strict';
import {componentApis} from '@gapscan/adapters';

test('React components: props, variants, sizes and states from TSX', () => {
  const source = `import React, {forwardRef} from 'react';
interface BaseProps { className?: string; disabled?: boolean }
export interface ButtonProps extends BaseProps {
  /** Visual style */ kind?: 'primary' | 'ghost' | 'danger';
  size?: "sm" | "md" | "lg";
  isBusy?: boolean; loading?: boolean;
  onClick?: (e: React.MouseEvent) => void; children?: React.ReactNode;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>((props, ref) => <button ref={ref} />);
type BadgeProps = {tone: 'success' | 'warning'; label: string};
export function Badge({tone, label}: BadgeProps) { return <span>{label}</span>; }
export const helper = () => null;`;
  const apis = componentApis(source, 'src/components.tsx');
  const button = apis.find(c => c.name === 'Button')!;
  assert.deepEqual(button.props.map(p => p.name), ['kind', 'size', 'isBusy', 'loading', 'disabled']);
  assert.deepEqual(button.variants, ['kind=primary', 'kind=ghost', 'kind=danger']);
  assert.deepEqual(button.sizes, ['sm', 'md', 'lg']);
  assert.deepEqual(button.states, ['loading', 'disabled']);
  const badge = apis.find(c => c.name === 'Badge')!;
  assert.deepEqual(badge.variants, ['tone=success', 'tone=warning']);
  assert.ok(!apis.some(c => c.name === 'helper'));
});

test('published declarations: MUI-style OwnProps with OverridableStringUnion', () => {
  const dts = `export interface ButtonPropsVariantOverrides {}
export interface ButtonOwnProps {
  children?: React.ReactNode;
  color?: OverridableStringUnion<'inherit' | 'primary' | 'secondary' | 'error', ButtonPropsColorOverrides>;
  disabled?: boolean;
  loading?: boolean | null;
  size?: OverridableStringUnion<'small' | 'medium' | 'large', ButtonPropsSizeOverrides>;
  variant?: OverridableStringUnion<'text' | 'outlined' | 'contained', ButtonPropsVariantOverrides>;
  startIcon?: React.ReactNode;
}
declare const Button: ExtendButtonBase<ButtonTypeMap>;
export default Button;`;
  const [button] = componentApis(dts, 'Button/Button.d.ts');
  assert.equal(button?.name, 'Button');
  assert.deepEqual(button?.sizes, ['small', 'medium', 'large']);
  assert.ok(['text', 'outlined', 'contained', 'color=primary', 'color=error'].every(v => button!.variants.includes(v)));
  assert.deepEqual(button?.states, ['disabled', 'loading']);
  assert.ok(button?.props.some(p => p.name === 'startIcon'));
});

test('aliases and const tuples resolve to their literal options (Ant Design style)', () => {
  const dts = `declare const _ButtonTypes: readonly ["default", "primary", "dashed", "link", "text"];
export type ButtonType = (typeof _ButtonTypes)[number];
export type SizeType = 'small' | 'middle' | 'large' | undefined;
export interface BaseButtonProps { type?: ButtonType; size?: SizeType; loading?: boolean | {delay?: number}; danger?: boolean; disabled?: boolean; htmlType?: 'submit' | 'reset' | 'button' }
export interface ButtonProps extends BaseButtonProps { href?: string }
declare const Button: React.ForwardRefExoticComponent<ButtonProps>;
export default Button;`;
  const [button] = componentApis(dts, 'Button.d.ts');
  assert.deepEqual(button?.variants, ['type=default', 'type=primary', 'type=dashed', 'type=link', 'type=text']);
  assert.deepEqual(button?.sizes, ['small', 'middle', 'large']);
  assert.deepEqual(button?.states, ['loading', 'disabled']);
  const html = componentApis(`export interface LinkButtonProps { type?: 'button' | 'submit' } export const LinkButton = (p: LinkButtonProps) => null;`, 'x.tsx')[0];
  assert.deepEqual(html?.variants, [], 'HTML button types are not style variants');
});

test('web components: one folder is one component, each tag a style, class fields the API', async () => {
  const {customElementApi} = await import('@gapscan/adapters');
  const bundle = `declare const buttonBaseClass: any;
export declare abstract class Button extends buttonBaseClass { disabled: boolean; softDisabled: boolean; href: string; trailingIcon: boolean; private handleClick; protected renderElevation(): void; static styles: unknown; }
export declare class FilledButton extends Button {}
export declare class OutlinedButton extends Button {}
declare global { interface HTMLElementTagNameMap { 'md-filled-button': MdFilledButton; 'md-outlined-button': MdOutlinedButton; 'md-filled-tonal-button': MdFilledTonalButton; } }
export declare class MdFilledButton extends FilledButton {}
export declare class MdOutlinedButton extends OutlinedButton {}
export declare class MdFilledTonalButton extends FilledButton {}`;
  const api = customElementApi(bundle, 'button.d.ts', 'Button')!;
  assert.equal(api.name, 'Button');
  assert.deepEqual(api.variants, ['filled', 'outlined', 'filled-tonal']);
  assert.deepEqual(api.props.map(p => p.name), ['disabled', 'softDisabled', 'href', 'trailingIcon']);
  assert.deepEqual(api.states, ['disabled']);
  assert.equal(customElementApi('export const x = 1;', 'x.d.ts', 'X'), null);
});
