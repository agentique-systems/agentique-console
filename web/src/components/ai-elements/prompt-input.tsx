"use client";

/**
 * Vendored from AI Elements (elements.ai-sdk.dev/components/prompt-input),
 * heavily trimmed. Upstream is 1463 lines and pulls `nanoid` plus the
 * `input-group`, `dropdown-menu`, `hover-card`, `select` and `command`
 * primitives — nearly all of it for file attachments, which this console has
 * no server support for.
 *
 * Kept: the form shell, the composition-safe textarea, the footer/tools
 * layout, the tooltip'd tool button, and the ChatStatus-driven submit button.
 * Dropped: attachments, the provider/controller contexts, tabs, the action
 * menu, and `input-group` — the console styles its own surface, the same way
 * tool.tsx dropped CodeBlock and shimmer.tsx dropped `motion`.
 *
 * The composition handling is the reason this is worth vendoring at all: the
 * hand-rolled composer submitted on Enter mid-IME-composition, which breaks
 * every CJK input method.
 */
import { CornerDownLeftIcon, SquareIcon, XIcon } from "lucide-react";
import type {
  ComponentProps,
  FormEvent,
  HTMLAttributes,
  KeyboardEventHandler,
  ReactNode,
} from "react";
import { Children, useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Inlined from the `ai` dependency: the four states a submit button shows. */
export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

export type PromptInputProps = Omit<
  HTMLAttributes<HTMLFormElement>,
  "onSubmit"
> & {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export const PromptInput = ({ className, ...props }: PromptInputProps) => (
  <form
    className={cn(
      "surface-raised flex w-full flex-col rounded-lg border border-border bg-card transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30",
      className,
    )}
    {...props}
  />
);

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputBody = ({
  className,
  ...props
}: PromptInputBodyProps) => (
  <div className={cn("flex min-w-0 flex-col", className)} {...props} />
);

export type PromptInputTextareaProps = ComponentProps<"textarea">;

export const PromptInputTextarea = ({
  onKeyDown,
  className,
  placeholder = "What would you like to know?",
  ...props
}: PromptInputTextareaProps) => {
  const [isComposing, setIsComposing] = useState(false);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (e) => {
      // The caller's handler goes first, and its preventDefault wins — that is
      // how the console keeps Shift+Tab for cycling the session mode.
      onKeyDown?.(e);
      if (e.defaultPrevented) return;

      if (e.key !== "Enter") return;
      // Mid-composition Enter commits the IME candidate; it is not a submit.
      if (isComposing || e.nativeEvent.isComposing) return;
      if (e.shiftKey) return;

      e.preventDefault();
      const { form } = e.currentTarget;
      const submit = form?.querySelector(
        'button[type="submit"]',
      ) as HTMLButtonElement | null;
      if (submit?.disabled) return;
      form?.requestSubmit();
    },
    [onKeyDown, isComposing],
  );

  return (
    <textarea
      className={cn(
        "field-sizing-content max-h-48 min-h-16 w-full resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      name="message"
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      {...props}
    />
  );
};

export type PromptInputFooterProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputFooter = ({
  className,
  ...props
}: PromptInputFooterProps) => (
  <div
    className={cn("flex items-center justify-between gap-2 px-2 pb-2", className)}
    {...props}
  />
);

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = ({
  className,
  ...props
}: PromptInputToolsProps) => (
  <div className={cn("flex min-w-0 items-center gap-2", className)} {...props} />
);

export type PromptInputButtonTooltip =
  | string
  | {
      content: ReactNode;
      shortcut?: string;
      side?: ComponentProps<typeof TooltipContent>["side"];
    };

export type PromptInputButtonProps = ComponentProps<typeof Button> & {
  tooltip?: PromptInputButtonTooltip;
};

export const PromptInputButton = ({
  variant = "ghost",
  className,
  size,
  tooltip,
  ...props
}: PromptInputButtonProps) => {
  // An icon on its own gets a square button; an icon plus a label gets a pill.
  const resolvedSize =
    size ?? (Children.count(props.children) > 1 ? "xs" : "icon-xs");

  const button = (
    <Button
      className={cn(className)}
      size={resolvedSize}
      type="button"
      variant={variant}
      {...props}
    />
  );

  if (!tooltip) return button;

  const content = typeof tooltip === "string" ? tooltip : tooltip.content;
  const shortcut = typeof tooltip === "string" ? undefined : tooltip.shortcut;
  const side = typeof tooltip === "string" ? "top" : (tooltip.side ?? "top");

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side={side}>
        {content}
        {shortcut && (
          <span className="ml-2 font-mono text-muted-foreground">{shortcut}</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
};

export type PromptInputSubmitProps = ComponentProps<typeof Button> & {
  status?: ChatStatus;
  onStop?: () => void;
};

export const PromptInputSubmit = ({
  className,
  variant = "default",
  size = "icon-xs",
  status = "ready",
  onStop,
  onClick,
  children,
  ...props
}: PromptInputSubmitProps) => {
  const generating = status === "submitted" || status === "streaming";

  let icon = <CornerDownLeftIcon className="size-3" />;
  if (status === "submitted") icon = <Spinner className="size-3" />;
  else if (status === "streaming") icon = <SquareIcon className="size-3 fill-current" />;
  else if (status === "error") icon = <XIcon className="size-3" />;

  return (
    <Button
      className={cn(className)}
      size={size}
      // Enter inside the textarea must never reach a stop button.
      type={generating && onStop ? "button" : "submit"}
      variant={variant}
      onClick={(event) => {
        if (generating && onStop) {
          event.preventDefault();
          onStop();
          return;
        }
        onClick?.(event);
      }}
      {...props}
    >
      {children ?? icon}
    </Button>
  );
};
