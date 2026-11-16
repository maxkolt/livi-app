import React from 'react';
let mockValues: unknown[]=[];let mockCursor=0;
const mockSubmit=jest.fn();
jest.mock('react',()=>({...jest.requireActual('react'),useState:(initial:unknown)=>{const i=mockCursor++;return [mockValues[i]??initial,(v:unknown)=>{mockValues[i]=v}];},useRef:()=>({current:false}),useEffect:()=>{}}));
jest.mock('react-native',()=>({View:'View',Text:'Text',TextInput:'TextInput',Pressable:'Pressable',StyleSheet:{create:(v:unknown)=>v},Keyboard:{dismiss:jest.fn()},Share:{share:jest.fn()}}));
jest.mock('@expo/vector-icons',()=>({MaterialCommunityIcons:'Icon'}));
jest.mock('expo-clipboard',()=>({setStringAsync:jest.fn()}));
jest.mock('../AppDialog',()=>({AppDialogModal:'Dialog'}));
jest.mock('../../utils/cosmetics',()=>({submitCosmeticFeedback:(text:string)=>mockSubmit(text)}));
jest.mock('../../sockets/modules/constants',()=>({API_BASE:'https://api.example.test'}));
jest.mock('../../utils/i18n',()=>({t:(key:string)=>key}));
jest.mock('../../screens/home/constants',()=>({}));
import { LiviRewardsDialog } from './LiviRewardsDialog';
const wallet={balance:0,feedbackSubmitted:false,feedbackGiftAvailable:false,invitedCount:0,invitePoints:10,prices:{background:50,frame:100}};
function render(){mockCursor=0;return LiviRewardsDialog({visible:true,onClose:jest.fn(),lang:'ru',wallet});}
function findInput(tree: React.ReactNode): React.ReactElement<any> | undefined {
  let result:React.ReactElement<any>|undefined;
  React.Children.forEach(tree,child=>{if(!React.isValidElement<any>(child))return;if(child.type==='TextInput')result=child;else result ||= findInput((child.props as {children?: React.ReactNode}).children);});return result;
}
beforeEach(()=>{mockValues=[];mockCursor=0;mockSubmit.mockReset().mockResolvedValue({});});
it('keeps submit in the fixed action bar with the keyboard open',()=>{
  const original=render();const input=findInput(original.props.children)!;
  input.props.onChangeText('Это мой отзыв для проверки формы');input.props.onFocus();
  const editing=render();expect(editing.props.message).toBeUndefined();
  expect(editing.props.actions).toEqual(expect.arrayContaining([expect.objectContaining({label:'rewardsFeedbackSend',variant:'primary',disabled:false})]));
  expect(findInput(editing.props.children)?.props.value).toContain('мой отзыв');
});
it('does not enable submission before twenty trimmed characters',()=>{
  expect(render().props.actions[1].disabled).toBe(true);
  findInput(render().props.children)!.props.onChangeText('  short  ');
  expect(render().props.actions[1].disabled).toBe(true);
});
