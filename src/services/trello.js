import { getMemory } from "../db/index.js";

const TRELLO_API_BASE = "https://api.trello.com/1";

export async function getTrelloCredentials(env, chatId) {
  let apiKey = env.TRELLO_API_KEY || null;
  let token = env.TRELLO_TOKEN || null;

  if (!apiKey && chatId) {
    apiKey = await getMemory(env, chatId, "TRELLO_API_KEY");
  }
  if (!token && chatId) {
    token = await getMemory(env, chatId, "TRELLO_TOKEN");
  }

  if (!apiKey || !token) {
    throw new Error(
      "Kredensial Trello (API Key / Token) belum tersedia. " +
      "Silakan simpan menggunakan `remember` (key: 'TRELLO_API_KEY' dan 'TRELLO_TOKEN') atau di environment worker."
    );
  }

  return { apiKey, token };
}

export async function getTrelloBoardId(env, chatId, boardIdArg) {
  if (boardIdArg) return boardIdArg;

  let boardId = env.TRELLO_BOARD_ID || null;
  if (!boardId && chatId) {
    boardId = await getMemory(env, chatId, "TRELLO_BOARD_ID");
  }

  if (!boardId) {
    throw new Error(
      "Board ID Trello tidak ditemukan. Berikan `boardId` saat memanggil tool " +
      "atau simpan `TRELLO_BOARD_ID` di memori via `remember`."
    );
  }

  return boardId;
}

export async function getTrelloBoard(env, chatId, boardId) {
  const { apiKey, token } = await getTrelloCredentials(env, chatId);
  const targetBoardId = await getTrelloBoardId(env, chatId, boardId);

  const url = `${TRELLO_API_BASE}/boards/${targetBoardId}?lists=open&cards=open&key=${apiKey}&token=${token}`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Trello API Error (${res.status}): ${errText}`);
  }
  const data = await res.json();
  return {
    id: data.id,
    name: data.name,
    desc: data.desc,
    url: data.url,
    lists: (data.lists || []).map((l) => ({ id: l.id, name: l.name })),
    cards: (data.cards || []).map((c) => ({
      id: c.id,
      name: c.name,
      idList: c.idList,
      desc: c.desc,
      url: c.url,
      labels: c.labels,
      due: c.due,
    })),
  };
}

export async function getTrelloLists(env, chatId, boardId) {
  const { apiKey, token } = await getTrelloCredentials(env, chatId);
  const targetBoardId = await getTrelloBoardId(env, chatId, boardId);

  const url = `${TRELLO_API_BASE}/boards/${targetBoardId}/lists?key=${apiKey}&token=${token}`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Trello API Error (${res.status}): ${errText}`);
  }
  const lists = await res.json();
  return lists.map((l) => ({ id: l.id, name: l.name, pos: l.pos }));
}

export async function createTrelloList(env, chatId, boardId, name) {
  const { apiKey, token } = await getTrelloCredentials(env, chatId);
  const targetBoardId = await getTrelloBoardId(env, chatId, boardId);

  const url = `${TRELLO_API_BASE}/lists?name=${encodeURIComponent(name)}&idBoard=${targetBoardId}&key=${apiKey}&token=${token}`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Trello API Error (${res.status}): ${errText}`);
  }
  return res.json();
}

export async function createTrelloCard(env, chatId, options) {
  const { apiKey, token } = await getTrelloCredentials(env, chatId);
  const {
    boardId,
    listId: inputListId,
    listName,
    name,
    desc,
    pos,
    due,
    subtasks,
    labels,
  } = options;

  let targetListId = inputListId;

  if (!targetListId) {
    const targetBoardId = await getTrelloBoardId(env, chatId, boardId);
    const lists = await getTrelloLists(env, chatId, targetBoardId);

    if (listName) {
      const match = lists.find(
        (l) => l.name.toLowerCase().trim() === listName.toLowerCase().trim()
      );
      if (match) {
        targetListId = match.id;
      } else {
        const newList = await createTrelloList(env, chatId, targetBoardId, listName);
        targetListId = newList.id;
      }
    } else if (lists.length > 0) {
      targetListId = lists[0].id;
    } else {
      const newList = await createTrelloList(env, chatId, targetBoardId, "To Do");
      targetListId = newList.id;
    }
  }

  const queryParams = new URLSearchParams({
    idList: targetListId,
    name: name || "Kartu Baru",
    key: apiKey,
    token: token,
  });
  if (desc) queryParams.append("desc", desc);
  if (pos) queryParams.append("pos", pos);
  if (due) queryParams.append("due", due);
  if (labels && labels.length > 0) queryParams.append("idLabels", labels.join(","));

  const url = `${TRELLO_API_BASE}/cards?${queryParams.toString()}`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Trello API Error (${res.status}): ${errText}`);
  }

  const cardData = await res.json();

  let checklistResult = null;
  if (subtasks && Array.isArray(subtasks) && subtasks.length > 0) {
    try {
      checklistResult = await addTrelloChecklistInternal(
        apiKey,
        token,
        cardData.id,
        "Sub-tugas",
        subtasks
      );
    } catch (err) {
      console.error("Gagal menambahkan checklist ke kartu Trello:", err);
    }
  }

  return {
    id: cardData.id,
    name: cardData.name,
    desc: cardData.desc,
    url: cardData.shortUrl || cardData.url,
    idList: cardData.idList,
    checklist: checklistResult,
  };
}

async function addTrelloChecklistInternal(apiKey, token, cardId, title, items) {
  const url = `${TRELLO_API_BASE}/cards/${cardId}/checklists?name=${encodeURIComponent(title)}&key=${apiKey}&token=${token}`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Trello Checklist Error (${res.status}): ${errText}`);
  }
  const checklist = await res.json();

  const itemResults = [];
  for (const itemText of items) {
    const itemUrl = `${TRELLO_API_BASE}/checklists/${checklist.id}/checkItems?name=${encodeURIComponent(itemText)}&key=${apiKey}&token=${token}`;
    const itemRes = await fetch(itemUrl, { method: "POST" });
    if (itemRes.ok) {
      itemResults.push(await itemRes.json());
    }
  }

  return {
    id: checklist.id,
    name: checklist.name,
    itemCount: itemResults.length,
  };
}

export async function addTrelloChecklist(env, chatId, cardId, title, items) {
  const { apiKey, token } = await getTrelloCredentials(env, chatId);
  return addTrelloChecklistInternal(apiKey, token, cardId, title || "Checklist", items || []);
}

export async function addTrelloAttachment(env, chatId, cardId, url, name) {
  const { apiKey, token } = await getTrelloCredentials(env, chatId);
  const endpoint = `${TRELLO_API_BASE}/cards/${cardId}/attachments?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name || "Attachment")}&key=${apiKey}&token=${token}`;
  const res = await fetch(endpoint, { method: "POST" });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Trello Attachment Error (${res.status}): ${errText}`);
  }
  return res.json();
}

export async function moveTrelloCard(env, chatId, cardId, options) {
  const { apiKey, token } = await getTrelloCredentials(env, chatId);
  let { targetListId, targetListName, boardId } = options;

  if (!targetListId && targetListName) {
    const targetBoardId = await getTrelloBoardId(env, chatId, boardId);
    const lists = await getTrelloLists(env, chatId, targetBoardId);
    const match = lists.find(
      (l) => l.name.toLowerCase().trim() === targetListName.toLowerCase().trim()
    );
    if (match) {
      targetListId = match.id;
    } else {
      const newList = await createTrelloList(env, chatId, targetBoardId, targetListName);
      targetListId = newList.id;
    }
  }

  if (!targetListId) {
    throw new Error("Target list ID atau target list name harus diberikan untuk memindahkan kartu.");
  }

  const endpoint = `${TRELLO_API_BASE}/cards/${cardId}?idList=${targetListId}&key=${apiKey}&token=${token}`;
  const res = await fetch(endpoint, { method: "PUT" });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Trello Move Card Error (${res.status}): ${errText}`);
  }
  return res.json();
}

export async function updateTrelloCard(env, chatId, cardId, updates) {
  const { apiKey, token } = await getTrelloCredentials(env, chatId);

  const queryParams = new URLSearchParams({
    key: apiKey,
    token: token,
  });

  if (updates.name) queryParams.append("name", updates.name);
  if (updates.desc) queryParams.append("desc", updates.desc);
  if (updates.closed !== undefined) queryParams.append("closed", String(updates.closed));
  if (updates.due) queryParams.append("due", updates.due);
  if (updates.idList) queryParams.append("idList", updates.idList);

  const endpoint = `${TRELLO_API_BASE}/cards/${cardId}?${queryParams.toString()}`;
  const res = await fetch(endpoint, { method: "PUT" });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Trello Update Card Error (${res.status}): ${errText}`);
  }
  return res.json();
}

export async function createTrelloBoard(env, chatId, name, desc) {
  const { apiKey, token } = await getTrelloCredentials(env, chatId);
  const endpoint = `${TRELLO_API_BASE}/boards?name=${encodeURIComponent(name)}&desc=${encodeURIComponent(desc || "")}&key=${apiKey}&token=${token}`;
  const res = await fetch(endpoint, { method: "POST" });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Trello Create Board Error (${res.status}): ${errText}`);
  }
  const board = await res.json();
  return {
    id: board.id,
    name: board.name,
    url: board.url,
  };
}
