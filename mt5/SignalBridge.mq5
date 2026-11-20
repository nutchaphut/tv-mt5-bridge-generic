//+------------------------------------------------------------------+
//| SignalBridge.mq5 - executes the tv-mt5-bridge Worker's signals.   |
//| Polls <WorkerUrl>/orders/<EaKey>, opens a market order with the    |
//| stop sent with the entry, closes on the exit line, and reports     |
//| every fill, skip and close (also broker stops and hand closes) to  |
//| <WorkerUrl>/fills/<EaKey>.                                         |
//| Attach to one chart per symbol. Tools > Options > Expert Advisors: |
//| allow WebRequest for your Worker URL.                              |
//| MIT licence. Not financial advice: run it on a demo account first. |
//+------------------------------------------------------------------+
#property strict
#property version   "1.00"
#include <Trade/Trade.mqh>

input string WorkerUrl    = "https://YOUR-WORKER.workers.dev"; // the Worker's address, no trailing slash
input string EaKey        = "";       // the Worker's EA_KEY secret
input double RiskPct      = 1.0;      // % of balance lost if the stop is hit
input string SignalSymbol = "";       // signal symbol to trade here; "" = chart symbol starting with it (XAUUSD -> XAUUSDm)
input bool   TestQueue    = false;    // true = take the Worker's test signals only (/test/<HOOK_KEY>)
input int    PollMs       = 2000;     // how often to ask the Worker (ms)
input int    MaxAgeSec    = 60;       // skip signals older than this: never send a stale order
input long   Magic        = 260101;   // marks this EA's positions
input int    SlippagePts  = 50;       // maximum price deviation in points

CTrade   trade;
long     lastId   = -1;               // newest signal handled; -1 = sync with the Worker first
string   pending[];                   // reports the Worker has not accepted yet, resent in order
datetime lastWarn = 0;
long     toldPos  = 0, toldMore[];    // positions whose close was already reported (never twice)
long     heldPos  = 0, heldId = 0;    // the position being watched, and its signal id

string Q()    { return TestQueue ? "1" : "0"; }
string Acct() { return (string)AccountInfoInteger(ACCOUNT_LOGIN); }
string Sig()  { return SignalSymbol != "" ? SignalSymbol : _Symbol; }
bool   Told(long pos) { if(pos == toldPos) return true; for(int i = 0; i < ArraySize(toldMore); i++) if(toldMore[i] == pos) return true; return false; }
void   Tell(long pos) { if(Told(pos)) return; if(toldPos != 0) { int n = ArraySize(toldMore); ArrayResize(toldMore, n + 1); toldMore[n] = toldPos; if(n > 50) ArrayRemove(toldMore, 0, 1); } toldPos = pos; }
void   Warn(string s) { if(TimeLocal() - lastWarn >= 60) { Print("SignalBridge: ", s); lastWarn = TimeLocal(); } }

bool Get(string path, string &out)
{
   char data[], res[];
   string hdr;
   ResetLastError();
   int code = WebRequest("GET", WorkerUrl + path, "", 5000, data, res, hdr);
   if(code != 200) { Warn("GET failed, HTTP " + (string)code + ", error " + (string)GetLastError() + " (WebRequest allowed for the Worker URL?)"); return false; }
   out = CharArrayToString(res, 0, WHOLE_ARRAY, CP_UTF8);
   return true;
}

bool Post(string path, string json)
{
   char data[], res[];
   string hdr;
   StringToCharArray(json, data, 0, -1, CP_UTF8);
   ArrayResize(data, ArraySize(data) - 1);          // drop the trailing null
   ResetLastError();
   int code = WebRequest("POST", WorkerUrl + path, "Content-Type: application/json\r\n", 5000, data, res, hdr);
   if(code != 200) { Warn("POST failed, HTTP " + (string)code + ", error " + (string)GetLastError()); return false; }
   return true;
}

// The broker's deal time as UTC milliseconds (MT5 times are server time; the server-to-GMT offset is applied). 0 = no deal.
long DealTimeUtcMs(ulong deal)
{
   if(deal == 0 || !HistoryDealSelect(deal)) return 0;
   long msc = HistoryDealGetInteger(deal, DEAL_TIME_MSC);
   if(msc <= 0) msc = (long)HistoryDealGetInteger(deal, DEAL_TIME) * 1000;
   if(msc <= 0) return 0;
   return msc + (long)(TimeGMT() - TimeCurrent()) * 1000;
}

// profit: net result of a closed position (EMPTY_VALUE = not a close); risk: money at risk when opened. Both stay in the
// Worker's database; Telegram only ever shows their ratio in R.
void Report(long id, string kind, bool ok, ulong deal, double price, double lots, string msg, double profit = EMPTY_VALUE, double risk = 0)
{
   StringReplace(msg, "\"", "'");
   string j = StringFormat("{\"event_id\":%I64d,\"kind\":\"%s\",\"ok\":%s,\"price\":%s,\"lots\":%s,\"msg\":\"%s\",\"test\":%s,\"profit\":%s,\"risk\":%s,\"at\":%I64d,\"acct\":\"%s\"}",
                           id, kind, ok ? "true" : "false", DoubleToString(price, _Digits), DoubleToString(lots, 2), msg, TestQueue ? "true" : "false",
                           profit == EMPTY_VALUE ? "null" : DoubleToString(profit, 2), DoubleToString(risk, 2), DealTimeUtcMs(deal), Acct());
   Print("SignalBridge: #", id, " ", kind, ok ? " OK " : " not done ", msg);
   // ponytail: kept in memory only, lost on an EA restart; write them to a file if Worker outages outlast restarts
   if(ArraySize(pending) > 0 || !Post("/fills/" + EaKey, j))
   {
      int n = ArraySize(pending);
      if(n < 200) { ArrayResize(pending, n + 1); pending[n] = j; }
   }
}

void FlushReports()
{
   int sent = 0;
   while(sent < ArraySize(pending) && Post("/fills/" + EaKey, pending[sent])) sent++;
   if(sent > 0) ArrayRemove(pending, 0, sent);
}

// The deal an order produced and its price. Some brokers answer OrderSend before the deal is booked (deal 0, price 0);
// it shows up in the history moments later. Waits up to ~2 s.
bool FillOf(ulong order, ulong &deal, double &price)
{
   if(order == 0) return false;
   for(int k = 0; k < 20; k++)
   {
      if(HistorySelect(TimeCurrent() - 86400, TimeCurrent() + 86400))
         for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
         {
            ulong d = HistoryDealGetTicket(i);
            if((ulong)HistoryDealGetInteger(d, DEAL_ORDER) == order) { deal = d; price = HistoryDealGetDouble(d, DEAL_PRICE); return true; }
         }
      Sleep(100);
   }
   return false;
}

// This chart's position (symbol and magic), left selected; its signal id sits in the comment "sb #<id>".
ulong MyPosition()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == Magic) return t;
   }
   return 0;
}
long PosSignal() { string c = PositionGetString(POSITION_COMMENT); int k = StringFind(c, "#"); return k < 0 ? 0 : StringToInteger(StringSubstr(c, k + 1)); }

double NetProfit(long posId)
{
   double sum = 0;
   if(!HistorySelectByPosition(posId)) return 0;
   for(int i = 0; i < HistoryDealsTotal(); i++)
   {
      ulong d = HistoryDealGetTicket(i);
      sum += HistoryDealGetDouble(d, DEAL_PROFIT) + HistoryDealGetDouble(d, DEAL_COMMISSION) + HistoryDealGetDouble(d, DEAL_SWAP) + HistoryDealGetDouble(d, DEAL_FEE);
   }
   return sum;
}

// Lots that lose RiskPct of the balance at the stop, rounded down to the volume step. 0 with why when not possible.
double LotsFor(ENUM_ORDER_TYPE type, double price, double sl, string &why, double &riskMoney)
{
   double loss1;
   if(!OrderCalcProfit(type, _Symbol, 1.0, price, sl, loss1) || loss1 >= 0) { why = "cannot size the trade"; return 0; }
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double lots = MathFloor(AccountInfoDouble(ACCOUNT_BALANCE) * RiskPct / 100.0 / MathAbs(loss1) / step) * step;
   lots = MathMin(lots, SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX));
   if(lots < SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN)) { why = StringFormat("%.2f%% risk is below the minimum lot", RiskPct); return 0; }
   lots = NormalizeDouble(lots, 2);
   riskMoney = MathAbs(loss1) * lots;
   return lots;
}

void Entry(long id, string side, double sl, int age)
{
   if(age > MaxAgeSec) { Report(id, "skip", false, 0, 0, 0, "signal " + (string)age + " s old"); return; }
   if(MyPosition() != 0) { Report(id, "skip", false, 0, 0, 0, "already in a position"); return; }
   bool   buy   = side == "long";
   double price = buy ? SymbolInfoDouble(_Symbol, SYMBOL_ASK) : SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double minDist = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * _Point;
   sl = NormalizeDouble(sl, _Digits);
   if(buy ? sl >= price - minDist : sl <= price + minDist)
   { Report(id, "skip", false, 0, price, 0, "stop " + DoubleToString(sl, _Digits) + " already passed or too close"); return; }
   string why = "";
   double riskMoney = 0;
   double lots = LotsFor(buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL, price, sl, why, riskMoney);
   if(lots <= 0) { Report(id, "skip", false, 0, price, 0, why); return; }
   double need;
   if(!OrderCalcMargin(buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL, _Symbol, lots, price, need) || need > AccountInfoDouble(ACCOUNT_MARGIN_FREE))
   { Report(id, "skip", false, 0, price, lots, "not enough free margin"); return; }   // skip, never shrink
   string cmt = "sb #" + (string)id;
   bool sent = buy ? trade.Buy(lots, _Symbol, 0, sl, 0, cmt) : trade.Sell(lots, _Symbol, 0, sl, 0, cmt);
   uint rc = trade.ResultRetcode();
   ulong deal = trade.ResultDeal();
   double px = trade.ResultPrice();
   if(sent && rc == TRADE_RETCODE_DONE && (deal == 0 || px <= 0)) FillOf(trade.ResultOrder(), deal, px);
   Report(id, "open", sent && rc == TRADE_RETCODE_DONE, deal, px, lots, trade.ResultRetcodeDescription(), EMPTY_VALUE, riskMoney);
}

void Close(long id)
{
   ulong t = MyPosition();
   if(t == 0) { Report(id, "skip", false, 0, 0, 0, "no open position to close"); return; }
   double lots = PositionGetDouble(POSITION_VOLUME);
   long posId = PositionGetInteger(POSITION_IDENTIFIER);
   bool ok = trade.PositionClose(t) && trade.ResultRetcode() == TRADE_RETCODE_DONE;
   if(!ok) { Report(id, "close", false, 0, 0, lots, trade.ResultRetcodeDescription()); return; }
   Tell(posId);
   ulong d = trade.ResultDeal();
   double p = trade.ResultPrice();
   if(d == 0 || p <= 0) FillOf(trade.ResultOrder(), d, p);
   Report(id, "close", true, d, p, lots, trade.ResultRetcodeDescription(), NetProfit(posId));
}

// "id|entry|symbol|side|sl|age|" or "id|exit|symbol|||age|entry id"
void Handle(string line)
{
   string f[];
   if(StringSplit(line, '|', f) < 6) return;
   long id = StringToInteger(f[0]);
   if(id > lastId) lastId = id;
   string ev = f[1], sym = f[2];
   if(SignalSymbol != "" ? sym != SignalSymbol : StringFind(_Symbol, sym) != 0) return;   // another chart's symbol
   if(ev == "entry") { Entry(id, f[3], StringToDouble(f[4]), (int)StringToInteger(f[5])); return; }
   if(ev != "exit") return;
   long want = ArraySize(f) >= 7 ? StringToInteger(f[6]) : 0;
   if(want > 0 && MyPosition() != 0 && PosSignal() > 0 && PosSignal() != want)
   { Report(id, "skip", false, 0, 0, 0, StringFormat("holding #%I64d, not this signal's position", PosSignal())); return; }
   Close(id);
}

// Closes the EA did not send (broker stop, stop-out, by hand): report them, the Worker never sees them otherwise.
void ReportClose(ulong deal, long posId, long id)
{
   long why = HistoryDealGetInteger(deal, DEAL_REASON);
   Tell(posId);
   if(why == DEAL_REASON_EXPERT) return;              // the EA's own close, reported by Close()
   string kind = why == DEAL_REASON_SL ? "stop" : why == DEAL_REASON_SO ? "stopout" : "manual";
   Report(id, kind, true, deal, HistoryDealGetDouble(deal, DEAL_PRICE), HistoryDealGetDouble(deal, DEAL_VOLUME), kind, NetProfit(posId));
}

long SignalOfPosition(long posId)                     // from the opening deal's comment "sb #<id>"
{
   if(!HistorySelectByPosition(posId)) return 0;
   for(int i = 0; i < HistoryDealsTotal(); i++)
   {
      string c = HistoryDealGetString(HistoryDealGetTicket(i), DEAL_COMMENT);
      if(StringFind(c, "sb #") == 0) return StringToInteger(StringSubstr(c, 4));
   }
   return 0;
}

void OnTradeTransaction(const MqlTradeTransaction &tx, const MqlTradeRequest &rq, const MqlTradeResult &rs)
{
   if(tx.type != TRADE_TRANSACTION_DEAL_ADD || !HistoryDealSelect(tx.deal)) return;
   if(HistoryDealGetString(tx.deal, DEAL_SYMBOL) != _Symbol || HistoryDealGetInteger(tx.deal, DEAL_MAGIC) != Magic) return;
   if(HistoryDealGetInteger(tx.deal, DEAL_ENTRY) != DEAL_ENTRY_OUT) return;
   long posId = HistoryDealGetInteger(tx.deal, DEAL_POSITION_ID);
   if(Told(posId)) return;
   ReportClose(tx.deal, posId, SignalOfPosition(posId));
}

// Backup for OnTradeTransaction: if the watched position is gone and nobody reported its close, report it from history.
void WatchPosition()
{
   if(MyPosition() != 0) { heldPos = PositionGetInteger(POSITION_IDENTIFIER); heldId = PosSignal(); return; }
   if(heldPos == 0) return;
   if(Told(heldPos) || !HistorySelectByPosition(heldPos)) { if(Told(heldPos)) heldPos = 0; return; }
   for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
   {
      ulong d = HistoryDealGetTicket(i);
      if(HistoryDealGetInteger(d, DEAL_ENTRY) == DEAL_ENTRY_OUT) { ReportClose(d, heldPos, heldId); heldPos = 0; return; }
   }
}

int OnInit()
{
   if(EaKey == "") { Alert("SignalBridge: set EaKey"); return INIT_PARAMETERS_INCORRECT; }
   lastId = -1;                                       // always re-sync: never replay old signals
   trade.SetExpertMagicNumber(Magic);
   trade.SetTypeFillingBySymbol(_Symbol);
   trade.SetDeviationInPoints(SlippagePts);
   EventSetMillisecondTimer(MathMax(500, PollMs));
   Print("SignalBridge: ", _Symbol, " takes ", Sig(), " signals, risk ", DoubleToString(RiskPct, 2), "%, ", TestQueue ? "TEST" : "live", " queue");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTimer()
{
   string body;
   if(lastId < 0)                                      // start after the newest signal
   {
      if(Get("/orders/" + EaKey + "/last?test=" + Q(), body)) { lastId = StringToInteger(body); Print("SignalBridge: synced after #", lastId); }
      return;
   }
   if(Get("/orders/" + EaKey + "?after=" + (string)lastId + "&test=" + Q() + "&acct=" + Acct(), body) && StringLen(body) > 0)
   {
      string lines[];
      int n = StringSplit(body, '\n', lines);
      for(int i = 0; i < n; i++) Handle(lines[i]);
   }
   if(ArraySize(pending) > 0) FlushReports();
   WatchPosition();
}
