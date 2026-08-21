"use client";

import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { memo, type ComponentProps } from "react";
import { Streamdown } from "streamdown";

const plugins = { cjk, code, math, mermaid };

type MarkdownProps = ComponentProps<typeof Streamdown>;

const components: MarkdownProps["components"] = {
  a: (props) => <a {...props} rel="noreferrer" target="_blank" />,
};

export const Markdown = memo(function Markdown(props: MarkdownProps) {
  return <Streamdown components={components} plugins={plugins} {...props} />;
});
