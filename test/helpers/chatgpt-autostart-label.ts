const {label}=await import('../../src/chatgpt/autostart.ts');
console.log(label({id:'default',label:'Default',baseURL:'https://chatgpt.com',created:'',source:{provider:'managed'}}));
