import { Streamdown } from "streamdown";
import { markdownPlugins } from "@/components/ai-elements/markdown-plugins";
import { cn } from "@/lib/utils";

/** Model-produced Markdown rendered safely: Streamdown escapes raw HTML and renders links without executing anything. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("prose prose-sm max-w-none dark:prose-invert [&_pre]:overflow-x-auto", className)}>
      <Streamdown plugins={markdownPlugins}>{text}</Streamdown>
    </div>
  );
}
