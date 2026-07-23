import { handleWebhook } from "./handlers/webhook.js";
import { handleCron } from "./handlers/cron.js";
import { handleAPI } from "./handlers/api.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Serve static HTML for root path
    if (url.pathname === "/" && request.method === "GET") {
      return getIndexHtml();
    }

    // Route to API handlers
    if (url.pathname.startsWith("/api/")) {
      return handleAPI(request, env, ctx);
    }

    // Route to webhook (Telegram)
    return handleWebhook(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    await handleCron(event, env, ctx);
  },
};

function getIndexHtml() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cocoa Chat</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        
        .container {
            background: white;
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            display: flex;
            flex-direction: column;
            width: 100%;
            max-width: 600px;
            height: 80vh;
        }
        
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 12px 12px 0 0;
            text-align: center;
        }
        
        .header h1 {
            font-size: 24px;
            margin-bottom: 5px;
        }
        
        .header p {
            font-size: 12px;
            opacity: 0.9;
        }
        
        .status {
            font-size: 11px;
            margin-top: 8px;
            opacity: 0.8;
        }
        
        .messages {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 15px;
        }
        
        .message {
            display: flex;
            animation: slideIn 0.3s ease-out;
        }
        
        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        .message.user {
            justify-content: flex-end;
        }
        
        .message.assistant {
            justify-content: flex-start;
        }
        
        .message-content {
            max-width: 70%;
            padding: 12px 16px;
            border-radius: 12px;
            word-wrap: break-word;
            line-height: 1.4;
            font-size: 14px;
        }
        
        .message.user .message-content {
            background: #667eea;
            color: white;
            border-bottom-right-radius: 4px;
        }
        
        .message.assistant .message-content {
            background: #f0f0f0;
            color: #333;
            border-bottom-left-radius: 4px;
        }
        
        .loading {
            display: flex;
            gap: 4px;
            align-items: center;
        }
        
        .loading span {
            width: 8px;
            height: 8px;
            background: #667eea;
            border-radius: 50%;
            animation: bounce 1.4s infinite;
        }
        
        .loading span:nth-child(2) {
            animation-delay: 0.2s;
        }
        
        .loading span:nth-child(3) {
            animation-delay: 0.4s;
        }
        
        @keyframes bounce {
            0%, 80%, 100% {
                opacity: 0.5;
                transform: translateY(0);
            }
            40% {
                opacity: 1;
                transform: translateY(-10px);
            }
        }
        
        .input-area {
            padding: 20px;
            border-top: 1px solid #e0e0e0;
            display: flex;
            gap: 10px;
        }
        
        .input-area input {
            flex: 1;
            border: 1px solid #ddd;
            border-radius: 24px;
            padding: 12px 16px;
            font-size: 14px;
            outline: none;
            transition: border-color 0.3s;
        }
        
        .input-area input:focus {
            border-color: #667eea;
        }
        
        .input-area button {
            background: #667eea;
            color: white;
            border: none;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
            transition: background 0.3s;
        }
        
        .input-area button:hover:not(:disabled) {
            background: #764ba2;
        }
        
        .input-area button:disabled {
            background: #ccc;
            cursor: not-allowed;
        }
        
        .info {
            background: #e8f4f8;
            color: #0066cc;
            padding: 10px;
            border-radius: 8px;
            margin: 10px 0;
            font-size: 12px;
        }
        
        .messages::-webkit-scrollbar {
            width: 6px;
        }
        
        .messages::-webkit-scrollbar-track {
            background: #f1f1f1;
            border-radius: 3px;
        }
        
        .messages::-webkit-scrollbar-thumb {
            background: #667eea;
            border-radius: 3px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 Cocoa</h1>
            <p>AI Assistant Chat</p>
            <div class="status" id="processingStatus"></div>
        </div>
        
        <div class="messages" id="messages"></div>
        
        <div class="input-area">
            <input 
                type="text" 
                id="input" 
                placeholder="Type your message..."
                autocomplete="off"
            />
            <button id="send" onclick="sendMessage()">➤</button>
        </div>
    </div>

    <script>
        const BASE_URL = window.location.origin;
        let isProcessing = false;
        let pollingAborted = false;

        async function loadHistory() {
            try {
                const response = await fetch(\`\${BASE_URL}/api/web-chat/history\`);
                const data = await response.json();
                
                const messagesEl = document.getElementById('messages');
                messagesEl.innerHTML = '';
                
                if (data.history && data.history.length > 0) {
                    data.history.forEach(msg => {
                        const text = msg.parts && msg.parts[0] ? msg.parts[0].text || '' : '';
                        if (text) {
                            addMessageToDOM(text, msg.role);
                        }
                    });
                } else {
                    addInfoMessage('👋 Halo! Aku Cocoa, AI assistantmu. Ada yang bisa aku bantu?');
                }
                
                messagesEl.scrollTop = messagesEl.scrollHeight;
            } catch (err) {
                console.error('Failed to load history:', err);
                addInfoMessage('Failed to load chat history. Starting fresh...');
            }
        }

        function addMessageToDOM(text, role = 'user') {
            const messagesEl = document.getElementById('messages');
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${role === 'user' ? 'user' : 'assistant'}\`;
            messageDiv.innerHTML = \`<div class="message-content">\${escapeHtml(text)}</div>\`;
            messagesEl.appendChild(messageDiv);
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        function addLoadingToDOM() {
            const messagesEl = document.getElementById('messages');
            const messageDiv = document.createElement('div');
            messageDiv.className = 'message assistant';
            messageDiv.id = 'loading-message';
            messageDiv.innerHTML = \`
                <div class="message-content">
                    <div class="loading">
                        <span></span>
                        <span></span>
                        <span></span>
                    </div>
                </div>
            \`;
            messagesEl.appendChild(messageDiv);
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        function removeLoadingFromDOM() {
            const loading = document.getElementById('loading-message');
            if (loading) loading.remove();
        }

        function addInfoMessage(text) {
            const messagesEl = document.getElementById('messages');
            const messageDiv = document.createElement('div');
            messageDiv.className = 'message assistant';
            messageDiv.innerHTML = \`<div class="message-content info">\${escapeHtml(text)}</div>\`;
            messagesEl.appendChild(messageDiv);
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        async function sendMessage() {
            const input = document.getElementById('input');
            const message = input.value.trim();

            if (!message || isProcessing) return;

            isProcessing = true;
            pollingAborted = false;
            input.disabled = true;
            document.getElementById('send').disabled = true;

            addMessageToDOM(message, 'user');
            input.value = '';
            addLoadingToDOM();
            updateProcessingStatus('Processing...');

            try {
                const sendResponse = await fetch(\`\${BASE_URL}/api/web-chat/send\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message })
                });

                if (!sendResponse.ok) {
                    const errData = await sendResponse.json().catch(() => ({}));
                    throw new Error(errData.error || 'Failed to send message');
                }

                const sendData = await sendResponse.json();

                let result = null;
                let attempts = 0;
                const maxAttempts = 240;
                const pollInterval = 1000;

                while (attempts < maxAttempts && !pollingAborted) {
                    const resultResponse = await fetch(\`\${BASE_URL}/api/web-chat/result\`);
                    
                    if (!resultResponse.ok) {
                        throw new Error(\`Result fetch failed: \${resultResponse.status}\`);
                    }

                    const data = await resultResponse.json();

                    if (data.status === 'ready') {
                        result = data;
                        break;
                    }

                    if (data.error) {
                        throw new Error(data.error);
                    }

                    await new Promise(r => setTimeout(r, pollInterval));
                    attempts++;
                }

                if (pollingAborted) {
                    throw new Error('Request cancelled');
                }

                if (!result) {
                    throw new Error(\`Timeout after \${attempts}s\`);
                }

                removeLoadingFromDOM();
                if (result.finalText) {
                    addMessageToDOM(result.finalText, 'assistant');
                } else if (result.error) {
                    addMessageToDOM(\`Error: \${result.error}\`, 'assistant');
                } else {
                    addMessageToDOM('No response received', 'assistant');
                }

            } catch (err) {
                removeLoadingFromDOM();
                addMessageToDOM(\`Error: \${err.message}\`, 'assistant');
                console.error('Error:', err);
            } finally {
                isProcessing = false;
                input.disabled = false;
                document.getElementById('send').disabled = false;
                input.focus();
                updateProcessingStatus('');
            }
        }

        function updateProcessingStatus(text) {
            const statusEl = document.getElementById('processingStatus');
            statusEl.textContent = text || '';
        }

        document.getElementById('input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !isProcessing) {
                sendMessage();
            }
        });

        window.addEventListener('load', loadHistory);
    </script>
</body>
</html>\`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
