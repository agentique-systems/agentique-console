"use client";

import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="smooth"
    resize="smooth"
    role="log"
    {...props}
  />
);

export type ConversationContentProps = ComponentProps<
  typeof StickToBottom.Content
>;

export const ConversationContent = ({
  className,
  ...props
}: ConversationContentProps) => (
  <StickToBottom.Content
    className={cn("flex flex-col gap-8 p-4", className)}
    {...props}
  />
);

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className,
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted",
          className,
        )}
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  );
};

/**
 * Transcript export, ported from upstream's ConversationDownload (added to AI
 * Elements after this file was first vendored).
 *
 * Local changes: upstream ships a Button pinned absolutely inside the
 * Conversation and takes an eagerly-built `messages` array. The console puts
 * the affordance in the session header instead and only folds the transcript
 * when the operator actually clicks, so this exports the two pure pieces
 * rather than the button.
 *
 * `UIMessage` is inlined to its structural shape, the same way message.tsx
 * inlines MessageRole — the `ai` package is a type-only dependency upstream.
 */
export interface DownloadableMessage {
  /** The speaker label: "operator", "orchestrator", a seat name. */
  role: string;
  parts: { type: string; text?: string }[];
}

const messageText = (message: DownloadableMessage): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");

const defaultFormatMessage = (message: DownloadableMessage): string => {
  const label = message.role.charAt(0).toUpperCase() + message.role.slice(1);
  return `**${label}:** ${messageText(message)}`;
};

export const messagesToMarkdown = (
  messages: readonly DownloadableMessage[],
  formatMessage: (
    message: DownloadableMessage,
    index: number,
  ) => string = defaultFormatMessage,
): string => messages.map((message, i) => formatMessage(message, i)).join("\n\n");

/** Blob + object URL, no network. Revokes immediately after the click. */
export function downloadMarkdown(markdown: string, filename: string): void {
  const url = URL.createObjectURL(
    new Blob([markdown], { type: "text/markdown" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
