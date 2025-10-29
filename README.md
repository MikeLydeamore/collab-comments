# Comment Tracker Extension

A VS Code extension for collaborative commenting with author tracking, timestamps, and threaded discussions - similar to Overleaf's commenting feature.

## Features

- **Inline Comments**: Add comments that appear inline in your editor and move with the text
- **Author Tracking**: Every comment records who wrote it and when
- **Threaded Replies**: Reply to comments to create discussion threads
- **Resolve/Unresolve**: Mark comment threads as resolved when issues are addressed
- **Delete with Confirmation**: Delete entire threads or individual replies with safety confirmations
- **Persistent Storage**: Comments are saved in `.vscode/collab-comments.json` and sync via Git
- **Configurable Author**: Set your default name in settings to avoid repeated prompts
- **Any File Type**: Works on any file - not just QMD or Markdown

## Usage

### Adding a Comment

**Method 1: Context Menu**
1. Place cursor on a line (or select text)
2. Right-click and choose "Add Comment"
3. Enter your comment text
4. Your name is automatically added (from settings or system username)

**Method 2: Plus Icon**
1. Click the `+` icon in the editor gutter
2. Type your comment and press `Ctrl+Enter`

### Replying to Comments

1. Click inside the comment thread
2. Type your reply in the text box
3. Press `Ctrl+Enter` to submit
4. Replies are visually distinguished with a `└─` prefix

### Resolving Comments

1. Click the checkmark (✓) button in the comment thread title bar
2. The author name changes to "RESOLVED - [Author Name]"
3. Click again to unresolve

### Deleting Comments

**Delete Entire Thread:**
- Click the trash icon (🗑️) in the comment thread title bar
- Confirm deletion in the modal dialog

**Delete Individual Reply:**
1. Open Command Palette (`Ctrl+Shift+P`)
2. Type "Delete Reply"
3. Select the reply to delete
4. Confirm deletion

### Viewing All Comments

1. Open Command Palette (`Ctrl+Shift+P`)
2. Type "View All Comments"
3. Select a comment to jump to its location

## Configuration

Set your default author name to avoid being prompted every time:

1. Open Settings (`Ctrl+,`)
2. Search for "Comment Tracker"
3. Set "Default Author" to your name

Or edit `settings.json`:
```json
{
  "commentTracker.defaultAuthor": "Your Name"
}
```

## Commands

| Command | Description |
|---------|-------------|
| `Comment Tracker: Add Comment` | Add a new comment at cursor position |
| `Comment Tracker: View All Comments` | List all comments in current file |
| `Comment Tracker: Delete Comment` | Delete a comment thread from a list |
| `Comment Tracker: Delete Reply` | Delete an individual reply from a thread |

## Storage

Comments are stored in `.vscode/collab-comments.json` within your workspace. This JSON file contains:
- Comment ID, text, author, and timestamp
- File path and line range information
- Threaded replies with their own authors and timestamps
- Resolved status

**Tip:** Commit this file to version control (Git) to share comments with your team!

## Requirements

- VS Code 1.85.0 or higher

## Installation

### From Source

1. Clone this repository
2. Run `npm install`
3. Run `npm run compile`
4. Press `F5` to open a new VS Code window with the extension loaded

## Use Cases

- **Collaborative Writing**: Add feedback on drafts without modifying the original text
- **Code Review**: Leave inline comments for discussion before making changes
- **Document Annotations**: Mark sections that need work or clarification
- **Teaching/Learning**: Instructors can comment on student code or documents
- **Personal Notes**: Track your own thoughts and TODOs within any file

## Tips

- Comments move with the text when you edit the file
- Use resolve to close discussions without deleting the history
- The JSON file can be committed to Git for team collaboration
- Set a default author name in settings to streamline your workflow

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

MIT
