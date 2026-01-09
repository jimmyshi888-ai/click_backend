import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

// 1. 環境設定
dotenv.config();
const app = express();
const PORT = 3000;

// 2. 安全性與 Middleware
app.use(cors({
  origin: 'http://localhost:5173', // 允許 Vite 前端連線
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// 3. 資料庫連線 (Google Sheets)
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// 解析環境變數中的 Credentials
let credentials;
try {
  credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
} catch (error) {
  console.error('錯誤: 無法解析 GOOGLE_CREDENTIALS，請檢查 .env 格式');
  process.exit(1);
}

// 建立 Google Auth 客戶端
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// --- 輔助函式 ---

// 讀取所有使用者資料
async function getUsers() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'users!A:G', // 讀取 A 到 G 欄
    });
    // 回傳 rows (若為空則回傳空陣列)
    return response.data.values || [];
  } catch (error) {
    console.error('讀取 Google Sheets 失敗:', error);
    throw error;
  }
}

// --- API 實作 ---

/**
 * POST /api/gacha
 * 功能：轉蛋 (支援單抽與十連抽)
 */
app.post('/api/gacha', async (req, res) => {
  // 預設抽 1 次，如果有傳 count 就用傳進來的數字
  const { userId, count = 1 } = req.body; 
  const PRICE_PER_PULL = 100;
  const totalCost = PRICE_PER_PULL * count;

  try {
    const rows = await getUsers();
    const rowIndex = rows.findIndex(row => row[0] === userId);

    if (rowIndex === -1) return res.status(404).json({ error: '找不到使用者' });

    // 1. 檢查餘額
    const currentCoins = parseInt(rows[rowIndex][4] || 0);
    if (currentCoins < totalCost) {
      return res.status(400).json({ error: `金幣不足！需要 ${totalCost} 金幣` });
    }

    // 2. 讀取獎品池 & 權重設定
    const allItems = await getItems();
    if (allItems.length === 0) return res.status(500).json({ error: '獎池是空的' });

    const rarityWeights = {
      'SECRET': 0.1,
      'SSR':    3,
      'SR':     15,
      'R':      30,
      'N':      52
    };

    // 計算總權重
    let totalWeight = 0;
    const pool = allItems.map(item => {
      const weight = rarityWeights[item.rarity] || 1;
      totalWeight += weight;
      return { ...item, weight };
    });

    // --- 3. 執行抽獎迴圈 (抽 count 次) ---
    const obtainedItems = [];
    const newInventoryRows = [];
    const timestamp = new Date().toISOString();

    for (let i = 0; i < count; i++) {
      let randomNum = Math.random() * totalWeight;
      let selectedItem = pool[0];

      for (const item of pool) {
        randomNum -= item.weight;
        if (randomNum < 0) {
          selectedItem = item;
          break;
        }
      }
      
      obtainedItems.push(selectedItem);
      
      // 準備寫入背包的資料列
      newInventoryRows.push([
        uuidv4(),
        userId,
        selectedItem.id,
        timestamp
      ]);
    }

    // 4. 執行交易 (批次寫入，效能較好)
    // 4-1. 扣除金幣
    const newCoins = currentCoins - totalCost;
    const sheetRowNumber = rowIndex + 1;
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `users!E${sheetRowNumber}`, 
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[newCoins]] }
    });

    // 4-2. 寫入背包 (一次寫入多行)
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'inventory!A:D',
      valueInputOption: 'USER_ENTERED',
      resource: { values: newInventoryRows },
    });

    // 回傳結果 (items 是一個陣列)
    res.json({ 
      success: true, 
      items: obtainedItems, // 注意這裡改成 items (複數)
      newCoins: newCoins 
    });

  } catch (error) {
    console.error('轉蛋失敗:', error);
    res.status(500).json({ error: '轉蛋機故障了，請稍後再試' });
  }
});

/**
 * POST /api/login
 * 功能：使用者登入
 * 邏輯：根據 Email 尋找使用者 -> 比對密碼 -> 回傳使用者資料
 */
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const rows = await getUsers();
    
    // 尋找使用者 (跳過標題列)
    // row[2] 是 email
    const userRow = rows.slice(1).find(row => row[2] === email);

    if (!userRow) {
      return res.status(401).json({ error: '帳號或密碼錯誤' });
    }

    // 比對密碼 (row[3] 是加密密碼)
    const isMatch = await bcrypt.compare(password, userRow[3]);

    if (!isMatch) {
      return res.status(401).json({ error: '帳號或密碼錯誤' });
    }

    // 組裝回傳資料 (不包含密碼)
    const user = {
      id: userRow[0],
      username: userRow[1],
      email: userRow[2],
      coins: parseInt(userRow[4] || 0),
      total_clicks: parseInt(userRow[5] || 0),
      created_at: userRow[6]
    };

    res.json({ message: '登入成功', user });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '伺服器錯誤，登入失敗' });
  }
});

/**
 * POST /api/update-score
 * 功能：更新分數
 * 邏輯：根據 userId 找到對應列 -> 更新 E (coins) 和 F (total_clicks) 欄位
 */
// 修改 server.js 的 update-score API

/**
 * POST /api/update-score
 * 功能：更新分數 (加入防回溯機制)
 */
app.post('/api/update-score', async (req, res) => {
  const { userId, coins, total_clicks } = req.body;

  if (!userId) {
    return res.status(400).json({ error: '缺少 User ID' });
  }

  try {
    const rows = await getUsers();
    
    // 1. 尋找使用者
    const rowIndex = rows.findIndex(row => row[0] === userId);

    if (rowIndex === -1) {
      return res.status(404).json({ error: '找不到使用者' });
    }

    // 2. 讀取目前資料庫裡的舊分數
    // rows[rowIndex] 是整列資料: [id, name, email, pass, coins, clicks, date]
    // coins 在 index 4, total_clicks 在 index 5
    const currentCoins = parseInt(rows[rowIndex][4] || 0);
    const currentClicks = parseInt(rows[rowIndex][5] || 0);

    // 3. ★ 關鍵邏輯：只有當「新分數 > 舊分數」時才更新
    // 這樣可以防止「遲到的舊請求」把分數覆蓋掉
    if (coins > currentCoins) {
      const sheetRowNumber = rowIndex + 1;
      const range = `users!E${sheetRowNumber}:F${sheetRowNumber}`;

      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: range,
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[coins, total_clicks]]
        }
      });
      
      console.log(`[更新成功] User: ${userId} | ${currentCoins} -> ${coins}`);
      res.json({ success: true, updated: true, coins });
    } else {
      // 如果新分數比舊分數低 (或相等)，代表這是過期的請求，忽略它
      console.log(`[忽略舊資料] User: ${userId} | DB: ${currentCoins} vs New: ${coins}`);
      res.json({ success: true, updated: false, message: 'New score is lower, ignored.' });
    }

  } catch (error) {
    console.error('更新分數失敗:', error);
    res.status(500).json({ error: '更新分數失敗' });
  }
});

/**
 * POST /api/gacha
 * 功能：轉蛋 (扣除金幣 -> 隨機取得物品 -> 存入背包)
 */
/**
 * POST /api/gacha
 * 功能：轉蛋 (權重版：SSR 最容易，N 最難)
 */
app.post('/api/gacha', async (req, res) => {
  const { userId } = req.body;
  const COST = 100; 

  try {
    const rows = await getUsers();
    const rowIndex = rows.findIndex(row => row[0] === userId);

    if (rowIndex === -1) return res.status(404).json({ error: '找不到使用者' });

    // 1. 檢查餘額
    const currentCoins = parseInt(rows[rowIndex][4] || 0);
    if (currentCoins < COST) {
      return res.status(400).json({ error: '金幣不足！需要 100 金幣' });
    }

    // 2. 讀取獎品池
    const allItems = await getItems();
    if (allItems.length === 0) return res.status(500).json({ error: '獎池是空的' });

    // --- ★★★ 修改開始：權重隨機演算法 ★★★ ---
    
    // 定義每個等級的「份額」(數字越大越容易抽到)
    // 你想要 SSR 最容易，N 最難，所以 SSR 給最大
    const rarityWeights = {
      'UR':  0.1,
      'SSR': 0.9, // 0.9% 機率 - 超級難抽！
      'SR':  9, // 9% 機率
      'R':   30,  // 30% 機率
      'N':   60,
      
    };

    // 計算總權重 (Total Weight)
    let totalWeight = 0;
    const pool = allItems.map(item => {
      // 取得該物品的權重，如果沒寫等級預設給 1
      // 這裡會把 Google Sheet 的 "SSR" 對應到上面的 60
      const weight = rarityWeights[item.rarity] || 1;
      totalWeight += weight;
      return { ...item, weight }; // 把權重綁定到物品上
    });

    // 產生一個 0 到 總權重 之間的隨機數字
    let randomNum = Math.random() * totalWeight;
    let randomItem = null;

    // 像輪盤一樣，看指針停在哪個區間
    for (const item of pool) {
      randomNum -= item.weight;
      if (randomNum < 0) {
        randomItem = item;
        break;
      }
    }
    
    // 防呆：萬一算錯沒抓到，就預設給第一個
    if (!randomItem) randomItem = pool[0];

    // --- ★★★ 修改結束 ★★★ ---

    // 3. 執行交易
    const newCoins = currentCoins - COST;
    const sheetRowNumber = rowIndex + 1;
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `users!E${sheetRowNumber}`, 
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[newCoins]] }
    });

    const newInvRow = [
      uuidv4(),
      userId,
      randomItem.id,
      new Date().toISOString()
    ];
    
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'inventory!A:D',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [newInvRow] },
    });

    res.json({ 
      success: true, 
      item: randomItem, 
      newCoins: newCoins 
    });

  } catch (error) {
    console.error('轉蛋失敗:', error);
    res.status(500).json({ error: '轉蛋機故障了，請稍後再試' });
  }
});

/**
 * POST /api/synthesize
 * 功能：物品合成 (3個低階 -> 1個高階)
 * 規則：N->R, R->SR, SR->SSR (UR不能合成)
 */
/**
 * POST /api/synthesize
 * 功能：指定物品合成 (接收 3 個 inventory_id -> 產出 1 個高階)
 */
app.post('/api/synthesize', async (req, res) => {
  const { userId, materialIds } = req.body;

  // 檢查是否選了 3 張
  if (!materialIds || materialIds.length !== 3) {
    return res.status(400).json({ error: '合成需要選擇 3 張卡片' });
  }

  try {
    const invResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'inventory!A:D',
    });
    const invRows = invResponse.data.values || [];
    const allItems = await getItems();

    const rowsToDelete = [];
    let sourceRarity = null;

    for (const targetInvId of materialIds) {
      const rowIndex = invRows.findIndex(row => row[0] === targetInvId);
      
      if (rowIndex === -1) {
        return res.status(404).json({ error: '找不到指定的卡片' });
      }

      const row = invRows[rowIndex];
      if (row[1] !== userId) {
        return res.status(403).json({ error: '你沒有這張卡片的權限' });
      }

      // ★ 關鍵邏輯：這裡是檢查「稀有度 (Rarity)」是否一致
      // 只要稀有度一樣 (例如都是 N)，不管卡片名字是不是一樣，都可以合成！
      const item = allItems.find(it => it.id === row[2]);
      
      if (!sourceRarity) sourceRarity = item.rarity;
      
      if (item.rarity !== sourceRarity) {
        return res.status(400).json({ error: '所有素材必須是「相同稀有度」' });
      }

      rowsToDelete.push(rowIndex + 1);
    }

    // 3. 決定目標稀有度
    const upgradeMap = { 'N': 'R', 'R': 'SR', 'SR': 'SSR' };
    const targetRarity = upgradeMap[sourceRarity];
    if (!targetRarity) return res.status(400).json({ error: '此稀有度無法再升級' });

    // 4. 執行刪除 (從後面往前刪，避免索引跑掉)
    rowsToDelete.sort((a, b) => b - a);
    for (const rowNum of rowsToDelete) {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SPREADSHEET_ID,
        range: `inventory!A${rowNum}:D${rowNum}`,
      });
    }

    // 5. 隨機產生新物品
    const targetItems = allItems.filter(item => item.rarity === targetRarity);
    const newItem = targetItems[Math.floor(Math.random() * targetItems.length)];

    // 6. 寫入新物品
    const newInvRow = [uuidv4(), userId, newItem.id, new Date().toISOString()];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'inventory!A:D',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [newInvRow] },
    });

    res.json({
      success: true,
      newItem: newItem,
      message: '合成成功！'
    });

  } catch (error) {
    console.error('合成失敗:', error);
    res.status(500).json({ error: '合成爐故障，請稍後再試' });
  }
});

// --- 排行榜與全服獎勵 API ---

/**
 * GET /api/leaderboard
 * 功能：取得前 10 名玩家 & 全服總點擊數
 */
app.get('/api/leaderboard', async (req, res) => {
  try {
    const rows = await getUsers();
    // rows[0] 是標題，從 index 1 開始是資料
    // id(0), username(1), email(2), password(3), coins(4), total_clicks(5)
    
    const allUsers = rows.slice(1).map(row => ({
      username: row[1],
      total_clicks: parseInt(row[5] || 0)
    }));

    // 1. 計算全服總點擊
    const globalTotal = allUsers.reduce((sum, user) => sum + user.total_clicks, 0);

    // 2. 排序取出前 10 名
    const top10 = allUsers
      .sort((a, b) => b.total_clicks - a.total_clicks)
      .slice(0, 10);

    res.json({ top10, globalTotal });

  } catch (error) {
    console.error('讀取排行榜失敗:', error);
    res.status(500).json({ error: '排行榜讀取失敗' });
  }
});

/**
 * POST /api/claim-global-reward
 * 功能：領取全服獎勵 (神秘大獎)
 */
/**
 * POST /api/claim-global-reward
 * 功能：領取全服里程碑獎勵 (支援金幣與物品)
 */
app.post('/api/claim-global-reward', async (req, res) => {
  const { userId, target } = req.body; // target: 2000, 2500, or 3000

  // 定義獎勵設定
  const rewards = {
    2000: { type: 'coin', value: 1000, recordId: 'REWARD_2000' },
    2500: { type: 'item', value: '501', recordId: '501' }, // 501 是新年快樂卡
    3000: { type: 'coin', value: 3000, recordId: 'REWARD_3000' }
  };

  const reward = rewards[target];
  if (!reward) return res.status(400).json({ error: '無效的獎勵目標' });

  try {
    const rows = await getUsers();
    
    // 1. 檢查全服進度
    const globalTotal = rows.slice(1).reduce((sum, row) => sum + parseInt(row[5] || 0), 0);
    if (globalTotal < target) {
      return res.status(400).json({ error: `全服目標 ${target} 尚未達成！` });
    }

    // 2. 檢查是否領過 (查背包紀錄)
    const invResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'inventory!A:D',
    });
    const invRows = invResponse.data.values || [];
    
    // 檢查是否有 recordId (不管是物品還是金幣紀錄)
    const hasClaimed = invRows.some(row => row[1] === userId && row[2] === reward.recordId);

    if (hasClaimed) {
      return res.status(400).json({ error: '你已經領過這個獎勵囉！' });
    }

    // 3. 發放獎勵
    if (reward.type === 'coin') {
      // --- 發金幣 ---
      const userIndex = rows.findIndex(row => row[0] === userId);
      if (userIndex === -1) return res.status(404).json({ error: '找不到使用者' });
      
      const currentCoins = parseInt(rows[userIndex][4] || 0);
      const newCoins = currentCoins + reward.value;
      const sheetRow = userIndex + 1;

      // 更新金幣
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `users!E${sheetRow}`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[newCoins]] }
      });
    } 
    
    // 4. 寫入領取紀錄 (如果是物品，這就是發物品；如果是金幣，這就是防重複領取的紀錄)
    const newInvRow = [
      uuidv4(),
      userId,
      reward.recordId, // 存入 501 或 REWARD_2000
      new Date().toISOString()
    ];
    
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'inventory!A:D',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [newInvRow] },
    });

    const msg = reward.type === 'coin' 
      ? `領取成功！獲得 ${reward.value} 金幣` 
      : '領取成功！卡片已放入背包';

    res.json({ success: true, message: msg, newCoins: reward.type === 'coin' ? reward.value : 0 });

  } catch (error) {
    console.error('領獎失敗:', error);
    res.status(500).json({ error: '領取失敗，請稍後再試' });
  }
});
// 啟動伺服器
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

// --- 新增：背包與物品相關 API ---

// 輔助函式：讀取物品列表 (items)
async function getItems() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'items!A:E', // 假設 items 表單有 A~E 欄
    });
    const rows = response.data.values || [];
    // 轉換成物件格式方便查詢
    // item_id(A), name(B), rarity(C), image_url(D), description(E)
    return rows.slice(1).map(row => ({
      id: row[0],
      name: row[1],
      rarity: row[2],
      image: row[3],
      desc: row[4]
    }));
  } catch (error) {
    console.error('讀取物品失敗:', error);
    return [];
  }
}

/**
 * GET /api/inventory/:userId
 * 功能：取得某位玩家的背包內容
 */
/**
 * GET /api/inventory/:userId
 * 功能：取得某位玩家的背包內容
 */
app.get('/api/inventory/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const invResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'inventory!A:D',
    });
    const invRows = invResponse.data.values || [];
    const userInventory = invRows.slice(1).filter(row => row[1] === userId);

    if (userInventory.length === 0) {
      return res.json({ items: [] });
    }

    const allItems = await getItems();

    const result = userInventory.map(invRow => {
      const itemId = invRow[2]; // 這是背包紀錄的 item_id (例如 REWARD_2000)
      const itemDetail = allItems.find(item => item.id === itemId);
      
      // ★ 修改這裡：無論有沒有查到 itemDetail，都要回傳 id
      return {
        inventory_id: invRow[0],
        obtained_at: invRow[3],
        id: itemId, // ★ 強制回傳 ID，這樣前端才能判斷是否領過
        ...itemDetail // 如果有詳細資料就展開，沒有就算了
      };
    });

    res.json({ items: result });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '讀取背包失敗' });
  }
});