import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface CommentData {
  id: string;
  author: string;
  timestamp: string;
  text: string;
  filePath: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  replies?: Array<{
    id: string;
    author: string;
    timestamp: string;
    text: string;
  }>;
  resolved?: boolean;
}

interface CommentStore {
  comments: CommentData[];
}

let commentController: vscode.CommentController;
let commentStore: CommentStore = { comments: [] };
const commentThreads = new Map<string, vscode.CommentThread>();
let saveTimeout: NodeJS.Timeout | undefined;
let commentsTreeProvider: CommentsTreeProvider;

export function activate(context: vscode.ExtensionContext) {
  console.log('Comment Tracker extension is now active!');

  // Create comment controller
  commentController = vscode.comments.createCommentController(
    'comment-tracker',
    'Comment Tracker'
  );

  // Configure to show comments on the side
  commentController.options = {
    prompt: 'Add a reply (Ctrl+Enter to submit)...',
    placeHolder: 'Type your reply here'
  };

  // Register comment reply handler
  commentController.commentingRangeProvider = {
    provideCommentingRanges: (document: vscode.TextDocument) => {
      // Allow commenting on any line
      const lineCount = document.lineCount;
      return [new vscode.Range(0, 0, lineCount - 1, 0)];
    }
  };

  context.subscriptions.push(commentController);

  // Load existing comments
  loadComments();
  restoreCommentThreads();

  // Listen for document changes to update comment positions
  const docChangeListener = vscode.workspace.onDidChangeTextDocument((e) => {
    updateCommentPositionsFromEdits(e);
  });

  context.subscriptions.push(docChangeListener);

  // Register commands
  const addCommentCmd = vscode.commands.registerCommand('comment-tracker.addComment', async () => {
    await addComment();
  });

  const viewCommentsCmd = vscode.commands.registerCommand('comment-tracker.viewComments', async () => {
    await viewComments();
  });

  const deleteCommentCmd = vscode.commands.registerCommand('comment-tracker.deleteComment', async () => {
    await deleteComment();
  });

  const deleteCommentThreadCmd = vscode.commands.registerCommand(
    'comment-tracker.deleteCommentThread',
    async (thread: vscode.CommentThread) => {
      await deleteCommentThread(thread);
    }
  );

  const replyToCommentCmd = vscode.commands.registerCommand(
    'comment-tracker.replyNote',
    async (reply: vscode.CommentReply) => {
      await replyToComment(reply);
    }
  );

  const resolveCommentThreadCmd = vscode.commands.registerCommand(
    'comment-tracker.resolveCommentThread',
    async (thread: vscode.CommentThread) => {
      await resolveCommentThread(thread);
    }
  );

  const unresolveCommentThreadCmd = vscode.commands.registerCommand(
    'comment-tracker.unresolveCommentThread',
    async (thread: vscode.CommentThread) => {
      await resolveCommentThread(thread);
    }
  );

  const deleteReplyCmd = vscode.commands.registerCommand(
    'comment-tracker.deleteReply',
    async () => {
      await deleteReplyInteractive();
    }
  );

  // Register tree view for unresolved comments
  commentsTreeProvider = new CommentsTreeProvider();
  vscode.window.registerTreeDataProvider('commentTrackerView', commentsTreeProvider);

  // Command to navigate to a comment from the tree view
  const navigateToCommentCmd = vscode.commands.registerCommand(
    'comment-tracker.navigateToComment',
    async (commentData: CommentData) => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return;
      }

      const uri = vscode.Uri.joinPath(workspaceFolder.uri, commentData.filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document);

      const position = new vscode.Position(commentData.range.start.line, commentData.range.start.character);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }
  );

  const exportToMarkdownCmd = vscode.commands.registerCommand(
    'comment-tracker.exportToMarkdown',
    async () => {
      if (commentStore.comments.length === 0) {
        vscode.window.showInformationMessage('No comments to export.');
        return;
      }

      let markdown = '# Comments\n\n';

      // Group comments by file
      const commentsByFile = new Map<string, CommentData[]>();
      for (const comment of commentStore.comments) {
        if (!commentsByFile.has(comment.filePath)) {
          commentsByFile.set(comment.filePath, []);
        }
        commentsByFile.get(comment.filePath)!.push(comment);
      }

      // Generate markdown for each file
      for (const [filePath, comments] of commentsByFile) {
        markdown += `## ${filePath}\n\n`;

        for (const comment of comments) {
          const status = comment.resolved ? '✅' : '❌';
          const line = comment.range.start.line + 1;
          markdown += `### ${status} Line ${line} - ${comment.author}\n\n`;
          markdown += `> ${comment.text}\n\n`;
          markdown += `*${new Date(comment.timestamp).toLocaleString()}*\n\n`;

          if (comment.replies && comment.replies.length > 0) {
            markdown += '**Replies:**\n\n';
            for (const reply of comment.replies) {
              markdown += `- **${reply.author}** (${new Date(reply.timestamp).toLocaleString()}): ${reply.text}\n`;
            }
            markdown += '\n';
          }
        }
      }

      // Copy to clipboard and show preview
      await vscode.env.clipboard.writeText(markdown);

      // Open in a new untitled document
      const doc = await vscode.workspace.openTextDocument({
        content: markdown,
        language: 'markdown'
      });
      await vscode.window.showTextDocument(doc);

      vscode.window.showInformationMessage('Comments exported to markdown and copied to clipboard!');
    }
  );

  context.subscriptions.push(addCommentCmd, viewCommentsCmd, deleteCommentCmd, deleteCommentThreadCmd, replyToCommentCmd, resolveCommentThreadCmd, unresolveCommentThreadCmd, deleteReplyCmd, navigateToCommentCmd, exportToMarkdownCmd);
}

class CommentsTreeProvider implements vscode.TreeDataProvider<CommentTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<CommentTreeItem | undefined | null | void> = new vscode.EventEmitter<CommentTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<CommentTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: CommentTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: CommentTreeItem): Thenable<CommentTreeItem[]> {
    if (element) {
      // If this is a reply item, it has no children
      if (element.replyData) {
        return Promise.resolve([]);
      }

      // For main comment items, show the comment text first, then replies
      const children: CommentTreeItem[] = [];

      // Add the comment text as a child item
      children.push(
        new CommentTreeItem(
          `${element.commentData.author}: ${element.commentData.text}`,
          vscode.TreeItemCollapsibleState.None,
          element.commentData,
          undefined,
          true // Mark as comment text item
        )
      );

      // Add replies if any
      if (element.commentData.replies && element.commentData.replies.length > 0) {
        element.commentData.replies.forEach(reply => {
          children.push(
            new CommentTreeItem(
              `  └─ ${reply.author}: ${reply.text}`,
              vscode.TreeItemCollapsibleState.None,
              element.commentData,
              reply
            )
          );
        });
      }

      return Promise.resolve(children);
    } else {
      // Root level - show all unresolved comments
      const unresolvedComments = commentStore.comments.filter(c => !c.resolved);

      if (unresolvedComments.length === 0) {
        return Promise.resolve([]);
      }

      return Promise.resolve(
        unresolvedComments.map(comment => {
          return new CommentTreeItem(
            `${comment.filePath}:${comment.range.start.line + 1}`,
            vscode.TreeItemCollapsibleState.Expanded, // Always expanded to show content
            comment
          );
        })
      );
    }
  }
}

class CommentTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly commentData: CommentData,
    public readonly replyData?: { author: string; timestamp: string; text: string },
    public readonly isCommentText?: boolean
  ) {
    super(label, collapsibleState);

    // Set tooltip and description based on item type
    if (isCommentText) {
      // This is the comment text child item - no description needed
      this.tooltip = `${commentData.author} - ${new Date(commentData.timestamp).toLocaleString()}\n\n${commentData.text}`;
      this.description = '';
    } else if (!replyData) {
      // This is the root comment item (filename:line)
      this.tooltip = `${commentData.author} - ${new Date(commentData.timestamp).toLocaleString()}\n\n${commentData.text}`;
      this.description = '';
    } else {
      // This is a reply item
      this.tooltip = `${commentData.author} - ${new Date(commentData.timestamp).toLocaleString()}`;
      this.description = '';
    }

    // Add command to navigate to comment when clicked (only for root items and comment text items)
    if (!replyData || isCommentText) {
      this.command = {
        command: 'comment-tracker.navigateToComment',
        title: 'Go to Comment',
        arguments: [commentData]
      };
    }
  }
}

async function getAuthorName(): Promise<string | undefined> {
  // Check if there's a configured default author
  const config = vscode.workspace.getConfiguration('commentTracker');
  const defaultAuthor = config.get<string>('defaultAuthor');

  if (defaultAuthor && defaultAuthor.trim() !== '') {
    return defaultAuthor.trim();
  }

  // Otherwise, prompt with system username as default
  const author = await vscode.window.showInputBox({
    prompt: 'Enter your name (or set a default in settings)',
    placeHolder: 'Your name',
    value: process.env.USER || process.env.USERNAME || 'Anonymous'
  });

  return author;
}

async function addComment() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor found');
    return;
  }

  const selection = editor.selection;
  let range = new vscode.Range(selection.start, selection.end);

  // If no text is selected (zero-length range), use the entire line
  if (range.isEmpty) {
    const line = editor.document.lineAt(selection.start.line);
    range = line.range;
  }

  const commentText = await vscode.window.showInputBox({
    prompt: 'Enter your comment',
    placeHolder: 'Type your comment here...'
  });

  if (!commentText) {
    return;
  }

  const author = await getAuthorName();

  if (!author) {
    return;
  }

  const commentId = Date.now().toString();
  const timestamp = new Date().toISOString();

  // Create comment thread
  const thread = commentController.createCommentThread(
    editor.document.uri,
    range,
    []
  );

  const vsComment: vscode.Comment = {
    body: new vscode.MarkdownString(`${new Date(timestamp).toLocaleString()}\n\n${commentText}`),
    mode: vscode.CommentMode.Preview,
    author: {
      name: author
    }
  };

  thread.comments = [vsComment];
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  thread.canReply = true;
  thread.contextValue = commentId;
  thread.state = vscode.CommentThreadState.Unresolved;

  // Store comment data
  const commentData: CommentData = {
    id: commentId,
    author,
    timestamp,
    text: commentText,
    filePath: vscode.workspace.asRelativePath(editor.document.uri),
    range: {
      start: { line: range.start.line, character: range.start.character },
      end: { line: range.end.line, character: range.end.character }
    },
    replies: [],
    resolved: false
  };

  commentStore.comments.push(commentData);
  commentThreads.set(commentId, thread);

  saveComments();

  vscode.window.showInformationMessage(`Comment added by ${author}`);
}

async function viewComments() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor found');
    return;
  }

  const filePath = vscode.workspace.asRelativePath(editor.document.uri);
  const fileComments = commentStore.comments.filter(c => c.filePath === filePath);

  if (fileComments.length === 0) {
    vscode.window.showInformationMessage('No comments found for this file');
    return;
  }

  const items = fileComments.map(c => ({
    label: `Line ${c.range.start.line + 1}: ${c.text}`,
    description: `by ${c.author} on ${new Date(c.timestamp).toLocaleString()}`,
    comment: c
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a comment to view'
  });

  if (selected) {
    const position = new vscode.Position(selected.comment.range.start.line, selected.comment.range.start.character);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }
}

async function deleteComment() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor found');
    return;
  }

  const filePath = vscode.workspace.asRelativePath(editor.document.uri);
  const fileComments = commentStore.comments.filter(c => c.filePath === filePath);

  if (fileComments.length === 0) {
    vscode.window.showInformationMessage('No comments found for this file');
    return;
  }

  const items = fileComments.map(c => ({
    label: `Line ${c.range.start.line + 1}: ${c.text}`,
    description: `by ${c.author} on ${new Date(c.timestamp).toLocaleString()}`,
    comment: c
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a comment to delete'
  });

  if (selected) {
    // Confirm deletion
    const confirm = await vscode.window.showWarningMessage(
      `Delete comment: "${selected.comment.text}"?`,
      { modal: true },
      'Delete'
    );

    if (confirm !== 'Delete') {
      return;
    }

    // Remove from store
    commentStore.comments = commentStore.comments.filter(c => c.id !== selected.comment.id);

    // Dispose comment thread
    const thread = commentThreads.get(selected.comment.id);
    if (thread) {
      thread.dispose();
      commentThreads.delete(selected.comment.id);
    }

    saveComments();
    vscode.window.showInformationMessage('Comment deleted');
  }
}

async function deleteCommentThread(thread: vscode.CommentThread) {
  const commentId = thread.contextValue;

  if (!commentId) {
    vscode.window.showErrorMessage('Unable to identify comment');
    return;
  }

  const commentData = commentStore.comments.find(c => c.id === commentId);
  if (!commentData) {
    vscode.window.showErrorMessage('Comment not found');
    return;
  }

  // Confirm deletion
  const confirm = await vscode.window.showWarningMessage(
    `Delete this comment thread?`,
    { modal: true },
    'Delete'
  );

  if (confirm !== 'Delete') {
    return;
  }

  // Remove from store
  commentStore.comments = commentStore.comments.filter(c => c.id !== commentId);

  // Dispose comment thread
  thread.dispose();
  commentThreads.delete(commentId);

  saveComments();
  vscode.window.showInformationMessage('Comment deleted');
}

async function resolveCommentThread(thread: vscode.CommentThread, toggleToResolved?: boolean) {
  const commentId = thread.contextValue;

  if (!commentId) {
    vscode.window.showErrorMessage('Unable to identify comment');
    return;
  }

  // If toggleToResolved not specified, toggle based on current state
  const commentData = commentStore.comments.find(c => c.id === commentId);
  if (!commentData) {
    vscode.window.showErrorMessage('Comment data not found');
    return;
  }

  const resolved = toggleToResolved !== undefined ? toggleToResolved : !commentData.resolved;

  // Update the thread state
  thread.state = resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;

  // Update the first comment to show resolved status
  if (thread.comments && thread.comments.length > 0) {
    const firstComment = thread.comments[0];
    const updatedComment: vscode.Comment = {
      ...firstComment,
      author: {
        name: resolved ? `RESOLVED - ${commentData.author}` : commentData.author
      }
    };
    thread.comments = [updatedComment, ...thread.comments.slice(1)];
  }

  // Update storage
  commentData.resolved = resolved;
  saveComments();
  vscode.window.showInformationMessage(resolved ? 'Comment resolved' : 'Comment unresolved');
}

async function deleteReplyInteractive() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor found');
    return;
  }

  const filePath = vscode.workspace.asRelativePath(editor.document.uri);
  const fileComments = commentStore.comments.filter(c => c.filePath === filePath);

  // Build a list of all replies
  const replyItems: Array<{
    label: string;
    description: string;
    commentData: CommentData;
    replyId: string;
  }> = [];

  for (const commentData of fileComments) {
    if (commentData.replies && commentData.replies.length > 0) {
      for (const reply of commentData.replies) {
        replyItems.push({
          label: `Line ${commentData.range.start.line + 1}: ${reply.text}`,
          description: `Reply by ${reply.author} on ${new Date(reply.timestamp).toLocaleString()}`,
          commentData,
          replyId: reply.id
        });
      }
    }
  }

  if (replyItems.length === 0) {
    vscode.window.showInformationMessage('No replies found in this file');
    return;
  }

  const selected = await vscode.window.showQuickPick(replyItems, {
    placeHolder: 'Select a reply to delete'
  });

  if (!selected) {
    return;
  }

  // Confirm deletion
  const confirm = await vscode.window.showWarningMessage(
    `Delete reply: "${selected.label}"?`,
    { modal: true },
    'Delete'
  );

  if (confirm !== 'Delete') {
    return;
  }

  // Find the thread
  const thread = commentThreads.get(selected.commentData.id);
  if (!thread) {
    vscode.window.showErrorMessage('Comment thread not found');
    return;
  }

  // Remove from storage
  if (selected.commentData.replies) {
    selected.commentData.replies = selected.commentData.replies.filter(r => r.id !== selected.replyId);
  }

  // Update the thread's comments
  thread.comments = thread.comments.filter(c => c.contextValue !== selected.replyId);

  saveComments();
  vscode.window.showInformationMessage('Reply deleted');
}

async function replyToComment(reply: vscode.CommentReply) {
  if (!reply || !reply.thread) {
    vscode.window.showErrorMessage('Invalid reply context');
    return;
  }

  const thread = reply.thread;
  const replyText = reply.text;

  if (!replyText) {
    return;
  }

  // Check if this is a NEW comment (empty thread) or a REPLY (thread has comments)
  const isNewComment = !thread.comments || thread.comments.length === 0;

  const author = await getAuthorName();

  if (!author) {
    return;
  }

  const timestamp = new Date().toISOString();

  if (isNewComment) {
    // This is a NEW comment from the + icon
    const commentId = Date.now().toString();

    const vsComment: vscode.Comment = {
      body: new vscode.MarkdownString(`${new Date(timestamp).toLocaleString()}\n\n${replyText}`),
      mode: vscode.CommentMode.Preview,
      author: {
        name: author
      }
    };

    thread.comments = [vsComment];
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.canReply = true;
    thread.contextValue = commentId;
    thread.state = vscode.CommentThreadState.Unresolved;

    // Store comment data
    const filePath = vscode.workspace.asRelativePath(thread.uri);
    const range = thread.range;

    if (!range) {
      vscode.window.showErrorMessage('Invalid comment range');
      return;
    }

    const commentData: CommentData = {
      id: commentId,
      author,
      timestamp,
      text: replyText,
      filePath,
      range: {
        start: { line: range.start.line, character: range.start.character },
        end: { line: range.end.line, character: range.end.character }
      },
      replies: [],
      resolved: false
    };

    commentStore.comments.push(commentData);
    commentThreads.set(commentId, thread);
    saveComments();

    vscode.window.showInformationMessage(`Comment added by ${author}`);
  } else {
    // This is a REPLY to an existing comment
    const replyId = `${thread.contextValue}-reply-${Date.now()}`;
    const newComment: vscode.Comment = {
      body: new vscode.MarkdownString(`└─ ${new Date(timestamp).toLocaleString()}\n\n${replyText}`),
      mode: vscode.CommentMode.Preview,
      author: {
        name: author
      },
      contextValue: replyId
    };

    // Add the new reply to the thread
    thread.comments = [...thread.comments, newComment];

    // Save the reply to storage
    const commentId = thread.contextValue;
    if (commentId) {
      const commentData = commentStore.comments.find(c => c.id === commentId);
      if (commentData) {
        if (!commentData.replies) {
          commentData.replies = [];
        }
        commentData.replies.push({
          id: replyId,
          author,
          timestamp,
          text: replyText
        });
        saveComments();
      }
    }

    vscode.window.showInformationMessage(`Reply added by ${author}`);
  }
}

function updateCommentPositionsFromEdits(event: vscode.TextDocumentChangeEvent) {
  const filePath = vscode.workspace.asRelativePath(event.document.uri);
  const threadsToUpdate: Array<{ id: string; newRange: vscode.Range; thread: vscode.CommentThread }> = [];

  // Process changes immediately and collect threads that need updating
  for (const change of event.contentChanges) {
    const changeStartLine = change.range.start.line;
    const changeEndLine = change.range.end.line;
    const linesAdded = change.text.split('\n').length - 1;
    const linesRemoved = changeEndLine - changeStartLine;
    const lineDelta = linesAdded - linesRemoved;

    if (lineDelta === 0) {
      continue; // No line changes, positions don't need updating
    }

    // Update all comments in this file that come after the change
    for (const commentData of commentStore.comments) {
      if (commentData.filePath === filePath) {
        // Determine if comment should move based on where the change occurred
        const shouldMove = commentData.range.start.line > changeStartLine;

        if (shouldMove) {
          commentData.range.start.line += lineDelta;
          commentData.range.end.line += lineDelta;

          // Collect thread for batch update
          const thread = commentThreads.get(commentData.id);
          if (thread) {
            const newRange = new vscode.Range(
              commentData.range.start.line,
              commentData.range.start.character,
              commentData.range.end.line,
              commentData.range.end.character
            );
            threadsToUpdate.push({ id: commentData.id, newRange, thread });
          }
        }
      }
    }
  }

  // Batch update all threads at once to minimize flicker
  for (const { id, newRange, thread } of threadsToUpdate) {
    thread.dispose();
    const newThread = commentController.createCommentThread(
      event.document.uri,
      newRange,
      thread.comments
    );
    newThread.collapsibleState = thread.collapsibleState;
    newThread.canReply = thread.canReply;
    newThread.contextValue = thread.contextValue;
    newThread.state = thread.state;
    commentThreads.set(id, newThread);
  }

  // Debounce only the save operation
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }

  saveTimeout = setTimeout(() => {
    saveComments();
  }, 500);
}

function restoreCommentThreads() {
  // Restore comment threads from stored data
  for (const commentData of commentStore.comments) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      continue;
    }

    const uri = vscode.Uri.joinPath(workspaceFolder.uri, commentData.filePath);
    const range = new vscode.Range(
      commentData.range.start.line,
      commentData.range.start.character,
      commentData.range.end.line,
      commentData.range.end.character
    );

    const thread = commentController.createCommentThread(uri, range, []);

    const vsComment: vscode.Comment = {
      body: new vscode.MarkdownString(`${new Date(commentData.timestamp).toLocaleString()}\n\n${commentData.text}`),
      mode: vscode.CommentMode.Preview,
      author: {
        name: commentData.resolved ? `RESOLVED - ${commentData.author}` : commentData.author
      }
    };

    // Build array of all comments (original + replies)
    const allComments = [vsComment];

    // Add replies if they exist
    if (commentData.replies && commentData.replies.length > 0) {
      for (const reply of commentData.replies) {
        const replyComment: vscode.Comment = {
          body: new vscode.MarkdownString(`└─ ${new Date(reply.timestamp).toLocaleString()}\n\n${reply.text}`),
          mode: vscode.CommentMode.Preview,
          author: {
            name: reply.author
          },
          contextValue: reply.id || `${commentData.id}-reply-${reply.timestamp}`
        };
        allComments.push(replyComment);
      }
    }

    thread.comments = allComments;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.contextValue = commentData.id;
    thread.canReply = true;
    thread.state = commentData.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;

    commentThreads.set(commentData.id, thread);
  }
}

function getCommentsFilePath(): string | undefined {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return undefined;
  }

  const vscodeDir = path.join(workspaceFolder.uri.fsPath, '.comments');
  if (!fs.existsSync(vscodeDir)) {
    fs.mkdirSync(vscodeDir, { recursive: true });
  }

  return path.join(vscodeDir, 'collab-comments.json');
}

function loadComments() {
  const filePath = getCommentsFilePath();
  if (!filePath || !fs.existsSync(filePath)) {
    return;
  }

  try {
    const data = fs.readFileSync(filePath, 'utf8');
    commentStore = JSON.parse(data);
  } catch (error) {
    console.error('Failed to load comments:', error);
  }
}

function saveComments() {
  const filePath = getCommentsFilePath();
  if (!filePath) {
    vscode.window.showErrorMessage('No workspace folder found');
    return;
  }

  try {
    fs.writeFileSync(filePath, JSON.stringify(commentStore, null, 2), 'utf8');
    // Refresh tree view
    if (commentsTreeProvider) {
      commentsTreeProvider.refresh();
    }
  } catch (error) {
    console.error('Failed to save comments:', error);
    vscode.window.showErrorMessage('Failed to save comments');
  }
}

export function deactivate() { }
