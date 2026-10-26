// Rank markers are stable IDs for equipment/coin clients. requiredXp is the
// separately versioned promotion requirement; calibrating it never renumbers a rank.
const entries=[
 ['recruit','훈련병',0,0],['private','이병',1000,100],['corporal','상병',3000,200],
 ['sergeant','병장',6000,300],['lieutenant','소위',10000,400],
 ['first_lieutenant','중위',18000,400],['captain','대위',30000,400],['major','소령',50000,400],
 ['lieutenant_colonel','중령',80000,400],['colonel','대령',120000,400],
 ['brigadier_general','준장',180000,400],['major_general','소장',260000,400],
 ['lieutenant_general','중장',360000,400],['general','대장',500000,400],
];
export const RANKS=Object.freeze(entries.map(([id,name,minXp,budgetBonus])=>Object.freeze({id,name,minXp,budgetBonus})));
const mastery=[
 [0,0,0,0,0],[3,2,5,0,0],[5,3,15,5,0],[7,5,30,12,5],[10,8,50,25,12],
 [12,12,90,45,24],[14,18,140,70,40],[16,25,220,110,65],[18,35,340,170,100],
 [20,45,500,250,150],[21,60,750,375,225],[22,80,1100,550,330],[23,100,1500,750,450],[23,140,2100,1050,630],
];
const experience=[
 [15,120,3,2,3,6],[30,300,3,2,5,8],[50,600,4,3,7,12],[80,1000,4,3,10,16],
 [120,1600,5,3,14,20],[180,2400,5,3,21,28],[250,3600,5,3,28,36],[350,5000,5,3,40,44],[500,7200,5,3,60,56],
];
export const PROMOTION_BASELINES=Object.freeze(RANKS.map((rank,i)=>{
 const [techniques,each,mobile,heavy,special]=mastery[i];
 const [matches,activeMinutes,opponents,maps,activeDays,targetHours]=experience[i-5]||[0,0,0,0,0,0];
 return Object.freeze({minXp:rank.minXp,requiredXp:rank.minXp,techniques,each,mobile,heavy,special,
  matches,activeMinutes,opponents,maps,activeDays,targetHours,adaptive:i>=5});
}));
