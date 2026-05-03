const firebaseConfig = {
  apiKey: "AIzaSyBiWwMal0ZP-VGzV6RS4yj8r0e0c7cM4oI",
  authDomain: "suc-dic.firebaseapp.com",
  databaseURL: "https://suc-dic-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "suc-dic",
  storageBucket: "suc-dic.firebasestorage.app",
  messagingSenderId: "851399882179",
  appId: "1:851399882179:web:f5d373dfac4ed4f7403976",
  measurementId: "G-J9THN6YJLW"
};
// 初始化 Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.database();
